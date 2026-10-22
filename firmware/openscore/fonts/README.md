# Bundled fonts

**Liberation Sans** (Regular + Bold, version 2.1.5) — metric-compatible with Arial (the font the
vendor board renders with), so openscore matches the original spacing/positioning and works with
no system fonts installed. openscore draws text of 26 px and under in `LiberationSans-Bold.ttf`
with anti-aliasing off (whole, fully lit pixels read better on LEDs), and bigger text in
`LiberationSans-Regular.ttf`, anti-aliased (`SMALL_TEXT_PX` in `openscore.py`).

Liberation fonts are © 2010 Google Corporation and © 2012 Red Hat, Inc., licensed under the
SIL Open Font License 1.1 — the full text, which has to travel with the fonts, is in
[`OFL.txt`](./OFL.txt). "Liberation" is a Reserved Font Name: a modified copy of these files must
be renamed.

**Arial is not bundled and must not be.** The board's own `ARIAL.TTF` is a proprietary Monotype
font that may not be redistributed; Liberation Sans exists precisely so that it does not have to be.
