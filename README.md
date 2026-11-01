<img src="assets/icon.svg" width="64" height="64" alt="">

# hermes-client

Created in [T3 Code](https://t3.codes).

A Tauri 2 + React desktop chat client for one remote Hermes Agent server. It signs in over SSH (see `docs/adr/0003-sign-in-through-ssh-tunnel-to-the-dashboard.md`) or straight to a dashboard URL (`docs/adr/0004-direct-url-sign-in-and-what-counts-as-unsecure.md`).

## Run

You need the Tauri 2 prerequisites on Arch:

```sh
sudo pacman -S --needed rust webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg
```

Then, from the repo root:

```sh
npm install
npm run app
```

`npm run app` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, which fixes the blank WebKitGTK window on some Wayland setups.

To sign in, enter an SSH target whose key works without a prompt (for example `liam@hermes`, or an alias from `~/.ssh/config`), plus the Hermes dashboard username and password. Or switch to URL and enter the dashboard's address, for example `http://hermes:9119`.

## Install

`packaging/aur/PKGBUILD` builds `hermes-chat-git` from `main` on GitHub. It installs the `hermes-chat` binary, its icons, and a launcher that sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`. To build and install it:

```sh
cd packaging/aur
makepkg -si
```

To run it from a terminal, set the variable yourself: `WEBKIT_DISABLE_DMABUF_RENDERER=1 hermes-chat`.

## Test

```sh
npm test                                  # frontend transport against a fake Hermes
cd src-tauri && cargo test --test transport   # Rust transport against a stub server
```
