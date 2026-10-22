# Bundled fonts

**Liberation Sans** (Regular + Bold) — metric-compatible with Arial (the font the vendor
board renders with), so openscore matches the original spacing/positioning and works with
no system fonts installed. Liberation fonts are licensed under the SIL Open Font License 1.1
(© Red Hat, Inc.). openscore draws text of 26 px and under in `LiberationSans-Bold.ttf` with
anti-aliasing off (whole, fully lit pixels read better on LEDs), and bigger text in
`LiberationSans-Regular.ttf`, anti-aliased (`SMALL_TEXT_PX` in `openscore.py`). Arial itself is
proprietary and is deliberately not bundled.
