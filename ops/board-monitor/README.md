# board-monitor

Watches the LedBox board from the home server, so the board can never again be dark for weeks without anyone
noticing. A systemd timer runs `board-monitor.sh` every 10 minutes. Each run:

- reads the board node's Online / LastSeen from `tailscale status --json`;
- when the node is online, checks that the console answers (`GET /generate_204` on :8890). Once an hour it
  also reads the open health routes `GET /api/system`, `/api/status` and `/api/uplink`, plus the TLS
  certificate's expiry on :8891. It appends one row per run to `board.db` (SQLite) next to the script;
- posts to ntfy only when something needs doing:
  - offline for more than 6 h with a home game in the next 72 h (the public Directus `/items/games`
    read, the same one `src/seasonSchedule.js` makes);
  - under-voltage, now or sticky since boot;
  - disk more than 85 % full;
  - clock not synced after 30 min of uptime;
  - TLS certificate valid for fewer than 20 more days;
  - the console not answering while the node is online.

  Each condition alerts at most once a day (`state.json`). After an outage the monitor sends one "back
  online" message;
- once a night, copies the board log lines that are new since the last pull to the NAS. Within the same board
  process it uses `GET /api/logs?sinceId=`. After a restart it uses `GET /api/logs/export`, filtered to lines
  newer than the last one pulled. It never pulls within 3 h of a home game.

The health routes are polled hourly, not every 10 minutes, for a reason. Every `/api/*` request counts as "a
console is watching" (`ledbox.noteViewer()`), which swaps the idle QR screen for the clock for 20 s.
`/generate_204` is answered before that code runs, so it leaves the panel alone.

All of this needs no secret. Every board route used is an open GET (reads stay open; see
`docs/logging-DESIGN.md`), the games list is a public read, and ntfy is local. The board's address is
resolved from its tailnet node name at run time and is never stored.

## Install (the paths are the home server's; adjust to yours)

```sh
mkdir -p ~/stacks/board-monitor && cp board-monitor.sh ~/stacks/board-monitor/
~/stacks/board-monitor/board-monitor.sh --dry-run   # prints what it would alert; posts and writes nothing
sudo install -m 644 board-monitor.service board-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now board-monitor.timer
journalctl -u board-monitor -n 30
```

Requires `bash`, `curl`, `jq`, `sqlite3`, `openssl` and `tailscale` on the monitoring host. It also needs an
SSH alias for the NAS (default `nas-ts`), with the target directory (`NAS_DIR`, default
`/volume1/backups/ledbox-board`) writable by the service user. Every setting at the top of the script can be
overridden from the environment with `systemctl edit board-monitor.service`. Examples: `BOARD_NODE`,
`BOARD_HALLS_RE` (halls the board serves, default `^KWI`), `NTFY_URL`, `NAS_HOST`, `NAS_DIR`.

`--pull-logs` pulls the logs right away. The board must still be reachable.
