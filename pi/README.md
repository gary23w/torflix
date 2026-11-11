# Torflix for the Raspberry Pi

Torflix for a Raspberry Pi that runs without a desktop, such as a RetroPie: Browse, title
pages with seasons and episodes, search, Continue watching and Settings, drawn on the TV and
played by the Pi's own video decoder (omxplayer). It is controlled with a keyboard or a
controller, and RetroPie lists it under Ports.

## What it needs

- A Raspberry Pi 2 or newer (a Pi 1 or Zero cannot run it).
- The Pi's legacy video driver and omxplayer, which Raspbian had until Raspberry Pi OS
  Bullseye. Tested on a Raspberry Pi 3 Model B with RetroPie 4.1 (Raspbian Jessie). On the
  64-bit Raspberry Pi OS with a desktop, the `arm64` Linux desktop build runs instead.
- `python3-pygame` and `omxplayer`. The installer adds them if they are missing.

Torflix brings its own Node.js (22, built on Alpine Linux's musl C library), so it does not
depend on the system's C library: it runs on Raspbian Jessie, whose glibc is too old for any
current Node.js.

## Install

```bash
tar -xzf Torflix-<version>-raspberry-pi.tar.gz
cd Torflix-<version>-raspberry-pi
./install.sh
```

It copies Torflix to `/opt/torflix` and adds Torflix to RetroPie's Ports. Restart
EmulationStation (or the Pi) to see it there. Without RetroPie, start it from the console (not
over SSH) with `/opt/torflix/torflix.sh`. Run a newer `install.sh` to update.

`/opt/torflix/uninstall.sh` removes it; add `--purge` to delete its settings and videos too.

## Controls

| | Keyboard | Controller |
| --- | --- | --- |
| Move | Arrows | D-pad or stick |
| Choose, pause | Enter | A |
| Back, stop | Esc or Backspace | B |
| Search (on Browse); subtitles while playing | Tab or S | X |
| Next audio track while playing | | Y |
| Settings (on Browse) | F1 | Start |
| Seek 30 s / 10 min while playing | ← → / ↑ ↓ | D-pad |
| Volume while playing | - and + | Shoulder buttons |

Controllers use the buttons set up in RetroPie (EmulationStation); one RetroPie does not know
gets a generic layout. On the search screen, typing on a keyboard works too.

## On a Raspberry Pi 3

- The Pi's decoder plays H.264 up to 1080p. HEVC (x265), AV1, HDR and 4K copies do not play:
  Torflix picks a copy the Pi can play, hides the 4K row, and marks the others.
- Every byte from a peer is decrypted and checked on the Pi's processor. Downloads start
  capped at 2 MB/s (Settings), which is twice what a 1080p film needs. Faster downloads
  kept a core so busy that the film stalled.
- Videos are kept in `~/Downloads/Torflix`, up to 4 GB to start with (Settings). Settings and
  Continue watching are in `~/.config/torflix`, with `torflix-tv.log` and `backend.log`.
- A Pi that shows a lightning bolt in the corner is short of power and may slow down.
- Peers are reached over TCP only (no uTP and no WebRTC), as on the Android TV app.
