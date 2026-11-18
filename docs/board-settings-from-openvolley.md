# Board settings from OpenVolley

A scorer who scores in OpenVolley with the board following the match can open the board's settings (brightness, orientation, mirror and the rest) from where they score, without leaving the match.

There are two ways to get there:

1. **Point Hub tablet app, OpenVolley layer.** The layer's top bar has **⚙ Board settings**. The layer is hidden, not closed, so OpenVolley keeps running with its match, its relay link and anything typed. The console's Settings tab comes up the way a tap on it does, with the scorer PIN as always. A bar above it says **‹ Back to the match**, and the Back key does the same. See android/BRIDGE.md, "Board settings from OpenVolley".
2. **OpenVolley itself, anywhere.** This works in a browser on the board's Wi-Fi, in the OpenVolley desktop and Android apps, and in the layer above. The scorer's **Match** menu gets **Scoreboard settings** while a scoreboard display follows the match and has named its settings page. That entry opens the console at `/#settings`, which opens Settings on load. Inside the Point Hub layer, that page is taken as the ⚙ button above.

OpenVolley stays brand-free: it only knows that "a scoreboard display" follows the match.

## The announcement (contract with OpenVolley)

The board labels every subscription it makes to an OpenVolley relay. That covers the scorer laptop, the board's own OpenVolley, and any other relay it links to. `src/boardAnnounce.js` builds the label and `src/relaySubscriber.js` sends it:

```jsonc
{ "type": "subscribe-match", "matchId": "<room key>", "device": "display", "settingsUrl": "http://172.24.1.1:8890/#settings" }
```

- `device: "display"` grants nothing. The board still gets the PIN-free summary and every live state, as before.
- `settingsUrl` is the console's Settings tab at its address on the board's own Wi-Fi (the AP) and its HTTP port (`CONTROL_PORT`, 8890). `BOARD_SETTINGS_URL` overrides it. `BOARD_SETTINGS_URL=off` announces the display without a page, and the scorer then gets no menu entry.
- The relays pass the page on **only to the match's scorer**, and only when it is an http(s) URL on a private-LAN address (10/8, 172.16/12, 192.168/16, or an IPv6 unique local address). The scorer's app checks it again before it offers it.
- The relay answers the scorer with `display-presence { matchId, present, settingsUrl }`. It is sent on the scorer's first sync and whenever a display comes, goes or names another page. The board never receives it.

The appliance sets the announcement when it starts (`src/appliance.js`). The headless bridge and the tests subscribe as before.

OpenVolley's side of this contract is in openvolley's `escoresheet/docs/scoreboard-display-spec.md`. Both repos test it:

- `test/board-announce-selftest.mjs` covers the board. Its last part runs against the real OpenVolley relay when `OPENVOLLEY_DIR` points at a checkout that has `display-presence`.
- OpenVolley's display-presence contract runs against every one of its relays.

## Limits

- The page is the AP address. A scorer on the bench cable (192.168.5.1) or on the cloud relay away from the board's Wi-Fi gets a link it cannot reach. In the tablet app the ⚙ button works on any of the board's networks, because it uses the console the app already has.
- One page per match. With two displays on one match, the scorer gets the page of the one that subscribed last.
