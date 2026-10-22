# FluxCast Quick Settings

GNOME Shell 50 extension that casts the screen to a TV through
[FluxCast](https://github.com/IlyaP358/fluxcast), straight from the
Quick Settings menu.

## Features

- Clicking the toggle scans for Wi-Fi Display sinks. If any are found the
  menu opens on the device list so you can pick the TV; otherwise it stays
  closed and the toggle reads "No devices found".
- Optional "Auto-connect to remembered TVs" switch: a click's scan stops as
  soon as a TV you have cast to before shows up, and connects to it straight
  away instead of opening the list.
- Casts right after a scan skip most of FluxCast's own peer scan
  (`--wfd-timeout 1`), since NetworkManager still lists the TV.
- Quick Settings menu with the device list, rescan and stop. Rescanning and
  flipping switches keep the menu open.
- Device scans run through FluxCast's own discovery code via `scan-helper.py`.
- Optional "Match TV resolution" switch: while casting, the primary monitor
  is temporarily put on its largest 16:9 mode (the shape of every Wi-Fi
  Display stream) so the TV shows no black bars. The original mode is restored
  when the cast ends.
- The panel icon appears only while a cast is starting or active. It stays
  hidden at idle and during scans.

## Configuration

The extension reads `~/.config/fluxcast-gnome-extension/config.json`:

| Key | Meaning |
| --- | --- |
| `fluxcast_path` | Path to a `fluxcast` executable or `main.py` |
| `app_dir` | FluxCast install directory (written automatically when detected) |
| `monitor` | Preferred monitor name (written after a successful auto-detect) |
| `auto_connect` | Auto-connect to a remembered TV after a click's scan (menu switch) |
| `known_devices` | TVs cast to before (`name`, Wi-Fi Direct `address`), most recent first |
| `match_resolution` | Switch to a 16:9 mode while casting (menu switch) |

## Requirements

- GNOME Shell 50
- [FluxCast](https://github.com/IlyaP358/fluxcast) installed and working for
  Wi-Fi Direct (`fluxcast --doctor`). The extension looks for it on `PATH`,
  in `/opt/fluxcast` and in `~/.local/opt/fluxcast`, or uses `fluxcast_path`
  from the config.

## Install

```sh
git clone https://github.com/cyborgcode/fluxcast-gnome-extension.git
cd fluxcast-gnome-extension
./install.sh
```

The installer copies the extension to
`~/.local/share/gnome-shell/extensions/fluxcast@rayen.local` and enables it.
Log out and back in to load it. Run it again after `git pull` to update.

## Optional FluxCast patch: skip the screen-share dialog

On GNOME Wayland, FluxCast asks for the screen to share in a portal dialog on
every cast. `patches/fluxcast-remember-screen-share.patch` makes FluxCast
save the approved choice (a portal restore token in
`~/.local/state/fluxcast/portal-restore-token`), so the dialog only appears
the first time. Apply it to the directory that contains FluxCast's `capture/`
folder:

```sh
patch -p1 -d ~/.local/opt/fluxcast < patches/fluxcast-remember-screen-share.patch   # installed copy
patch -p1 -d src < /path/to/fluxcast-remember-screen-share.patch                  # FluxCast git checkout
```

Once the choice is remembered, casts start sharing the screen without asking.
Delete the token file to get the dialog back.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
