# Do Not Use

Project merged to https://github.com/CurbSoftware/desktop-xlets.

# Color Timer Clock for GNOME Shell

Clock, timer and chronometer cards on the desktop whose background
colors ramp along per-card schedules: the clock by time of day, the
timer by seconds remaining, the chronometer by seconds elapsed.
Timer and chronometer controls live on the cards; the footer bar counts
down to the next color. Drag the widget with Alt+left button.

Ported from the Cinnamon Color Timer Clock desklet
(`cinnamon-color-timer-clock-desklet@curbsoftware` in the same
monorepo). Settings live in
`~/.config/gnome-color-clock@curbsoftware/settings.json`, including the
running timer and chronometer state, which survives reloads and reboots.

## Install

```bash
gnome-extensions install --force gnome-color-clock@curbsoftware.zip
gnome-extensions enable gnome-color-clock@curbsoftware
```

On Wayland the extension loads after the next login; on X11 Alt+F2 then
`r` restarts the shell immediately.

To install every CurbSoftware widget for this desktop (and Cinnamon or
Plasma) in one download, use the bundle AppImage:
https://github.com/CurbSoftware/curb-desktop-widgets/releases/latest

## Development

See `DEVELOPMENT.md`. Headless tests:

```bash
gjs -m dev-tools/test-gnome-color-clock.js
```
