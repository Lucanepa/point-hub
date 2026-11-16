# Board screen splash

What the Point Hub board's touchscreen shows while something starts: the Point Hub mark with a
volleyball, a whistle and a basketball on three crossed orbits (svrz_rc's spinner, with a third
orbit), the name, a progress bar that never stands still and a phrase that changes every 1.6 s
(`words.json`, as wiedisync's loading screen).

- **Power-up:** the Plymouth theme in `plymouth/` (`pointhub.script`), from the first seconds of the
  boot. `setup-board.sh` installs it, boots quietly (`quiet splash ... vt.global_cursor_default=0`)
  and turns off the firmware's rainbow (`disable_splash=1`). `pointhub-screen.service` ends Plymouth
  with `--retain-splash`, so the picture stays until the screen's compositor takes over.
- **Every app start** (power-up, Switch app, Quit in OpenVolley): `pointhub-screen` puts the still
  `splash-*.png` up at once (swaybg), then `splash.html` moving in its own Chromium under the app.
  It closes a few seconds after the app's window appears (labwc window rule), at the latest after two
  minutes.

Everything here is generated: edit `gen.mjs`, `words.json` or `plymouth/pointhub.script`, then

```bash
PLAYWRIGHT=/path/to/node_modules/playwright node firmware/screen-splash/gen.mjs
```

The ball and whistle are Game Icons (CC BY 3.0, see NOTICE); the basketball is drawn in `gen.mjs`.
