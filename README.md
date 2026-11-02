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

To sign in, enter an SSH target whose key works without a prompt (for example `liam@hermes`, or an alias from `~/.ssh/config`), plus the Hermes dashboard username and password. Or switch to URL and enter the dashboard's address, for example `http://hermes:9119`. If a gateway such as Cloudflare Access sits in front of it, add the headers it needs under **Extra request headers**, for example `CF-Access-Client-Id` and `CF-Access-Client-Secret` (ADR 0006).

## Voice

The composer's microphone button starts Dictation: speak, press Done, and the text appears in the composer to edit before sending. Read aloud, under each reply, has Hermes speak it. Hermes does the transcribing and the speaking on the server, with the profile's speech-to-text and text-to-speech providers (set them with `hermes tools` on the server). Settings → General → Voice shows which providers the profile uses and what each one needs. The app needs a working microphone and a PipeWire or PulseAudio sound server.

## Install

`packaging/aur/PKGBUILD` builds `hermes-chat-git` from `main` on GitHub. It installs the `hermes-chat` binary, its icons, and a launcher that sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`. To build and install it:

```sh
cd packaging/aur
makepkg -si
```

To run it from a terminal, set the variable yourself: `WEBKIT_DISABLE_DMABUF_RENDERER=1 hermes-chat`.

## Two chats side by side

Click the split button in the chat header, or press Ctrl+\, to open a second view of the chat. A chat's right-click
menu can open it in the left or right pane. Clicking or tabbing into a pane makes it active; the accent line marks
it. The chat list, Search (Ctrl+K), New chat (Ctrl+N) and Find (Ctrl+F) target that pane. Ctrl+1 and Ctrl+2 focus the
left and right composers. Close either pane with its header's ×; Ctrl+\ keeps the active pane and closes the other.

Drag the divider to resize, use its arrow keys/Home/End, or double-click it for equal widths. If relayout is slow on a
long chat, dragging switches to a guide line and commits the width on release. When fewer than 646 pixels remain for
the chats, a Left/Right switcher shows one pane at a time. Ctrl+B hides the chat list to make room.

Different chats keep their own drafts, transcripts, replies and unread state. Showing the same chat twice shares its
draft and reply; sending, stopping or answering an Approval in either view acts on that one chat. Scroll, Find and
pending attachments belong to each view. Closing a pane keeps the draft and any running reply; unsent attachments
in that view are discarded. Settings preserves the views. Switching profile returns to one New chat pane; drafts
remain scoped to their connection and profile. Split layout and scroll positions last for the current app run.
The existing Preview Pane is available from either header and uses the same connection/profile as the chats.
Leaving a pane cancels its Dictation and stops its Read aloud audio, so a hidden or unfocused pane cannot keep the
microphone or audio running or take composer focus when a late transcript arrives.
## Persona

Settings → Persona edits the shown profile's `SOUL.md` on the Hermes server, the file that says who Hermes is in that profile. It shows the server, profile and file path, and edits the Markdown as plain text. Save checks that the file hasn't changed on the server since you started; if it has, nothing is written and you choose what to keep. After writing, the app reads the file back to confirm it. New chats use the saved persona; chats already under way keep theirs, and Hermes doesn't restart. Unsaved changes stay on this computer if you leave, close the app or sign out. The last five versions a save replaced can be viewed and put back. It needs the dashboard's `/api/profiles/{name}/soul` routes, which the deployed Hermes (`bf0203a`) has (ADR 0011).

## Screenshots

Ctrl+Shift+S (or the camera button in the composer) takes a screenshot of a region or window and attaches it to the message you're writing, for you to review before sending. Change or turn off the shortcut in Settings → General → Screenshots.

- **Hyprland, Sway and other wlroots compositors:** install `slurp` and `grim` (`sudo pacman -S --needed slurp grim`). You drag a region, or click a window. Without them the app says what to install and captures nothing, because the screenshot portals there can't let you pick.
- **GNOME and KDE Plasma:** the desktop's screenshot portal shows its own region and window picker. It needs `xdg-desktop-portal` and `xdg-desktop-portal-gnome` or `xdg-desktop-portal-kde`.

That shortcut works only while Hermes Chat is focused. Wayland apps can't see keys pressed in other windows, so for a shortcut that works anywhere, bind a key in your desktop's settings to `hermes-chat --screenshot`. For example, on Hyprland: `bind = SUPER SHIFT, S, exec, hermes-chat --screenshot`. If Hermes Chat is open, the screenshot goes to the chat on screen. If it isn't open, or is on the sign-in screen, the screenshot is taken once you're signed in, if that's within two minutes. When it might need to start, use `env WEBKIT_DISABLE_DMABUF_RENDERER=1 hermes-chat --screenshot`.

Captures wait in `$XDG_CACHE_HOME/hermes-chat/captures/` (usually `~/.cache/hermes-chat/captures/`), readable only by you. Nothing is uploaded until you send the message. A capture is deleted once Hermes confirms its message, when you remove it from the composer, or when you leave the composer without sending it. Failed or uncertain messages keep their screenshots in the chat's outbox for Retry, including across app restarts; confirmation, history reconciliation or Dismiss releases them. On quit, remaining captures wait for the next startup to reconcile the persisted outbox and remove leftovers that no message needs.

## Test

```sh
npm test                                  # frontend transport against a fake Hermes
cd src-tauri && cargo test --lib --test transport --test media --test screenshot  # Rust transport, microphone origins, screenshot storage and requests
```

`node bench/run.mjs` renders the chat pane with synthetic long chats (50, 200 and 800 turns) in headless Chromium and
times opening, streaming, find-in-chat and scrolling, with memory after each open. It also measures two chats
streaming simultaneously, keyboard resizing and real-pointer divider dragging. It uses Playwright's cached headless
Chromium, or the browser in `$CHROME`; `THROTTLE=4` slows the CPU four times.
