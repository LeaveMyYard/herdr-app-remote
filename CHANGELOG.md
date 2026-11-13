# Changelog

All notable changes. The format follows Keep a Changelog; versions follow semantic versioning once a first release is cut.

## [0.1.0] - unreleased

First release candidate: phone access to herdr-app over Tailscale. Nothing here is tagged or published yet.

### Added

- Bridge (Node >= 22, one bundled file) with the snapshot/patch hub, the `host`, `plugins`, `panorama`, `inbox`, `usage`, `chat:<t>` and `setup` topics, and loopback-only listeners.
- Mod `herdr-app-remote` for herdr-app: the 1 px link block that mirrors host state and starts the bridge, and the desktop Remote panel (Status, Devices, Plugins, Activity, Setup).
- Tab icon `mods/herdr-app-remote/remote.svg` (24 px grid, `currentColor` stroke, like the files and changes mods), installed and recorded with the mod.
- The Home Screen icon, favicon and in-app logo can be the herdr-app icon: `scripts/app-install` renders them from the operator's own `herdr-app.svg` (next to the `herdr-app` binary, or `--icon /abs/path`) with a pinned WASM rasterizer, records the files like any other, and keeps the neutral icons (with one line saying so) when it finds none. The repository and release never contain herdr-app art.
- Installer `scripts/app-install` (install, upgrade, uninstall) with an install record of sha256 hashes, two derived layouts (`herdr-remote`, `panorama-remote`), and an optional panel key.
- Security layer: Host, Origin and identity guards, Funnel refusal, pairing with approval, a `__Host-` cookie, per-device capabilities (`view`, `inbox.answer`, `navigate`, `terminal.input`, `push`), rate limits, pause, and an audit log without free text.
- Phone app (PWA): Agents (Basic, and Swarm and Peek with panorama), Inbox with answering, Usage, read-only Chat, banners, Missing screens for absent plugins.
- Terminal input (`hc send`), off by default, desktop-only switch with expiry, length-only audit.
- Special keys (S16b, PR #22): a Keys sheet with a default menu (Esc, Tab, Shift-Tab, Ctrl-C, arrows) that a `data/herdr-app-remote/keys.json` list of `{label, keys}` entries replaces entirely (the defaults are used only when the file is missing or invalid) under a separate `terminal.keys` capability that is off by default, has its own expiry and a "Special keys" desktop switch, uses a strict key-token allowlist and a rate limit, and logs identifiers only.
- Chat history capability (CV1): `transcript.read`, separate from `view`, off for every device, no expiry, with a "Chat history" switch in the desktop Remote panel. It gates the chat view topics `chatview:<t>` and `timeline:<t>` (refused `sub`s get `stale forbidden`; turning it off ends open subscriptions) and the chat history pages that later slices add. `devices.json` gains the field (read as off when missing; no downgrade).
- Phone pairing (S5b, PR #24): the `/pair#c=` screen in Safari, a dismissible "Add to Home Screen" prompt with a bell to reopen it, and the Home Screen app pairing itself on first launch through a one-time transfer code (`/pair#t=`; 10 minutes, single use, bound to the paired device, a second token for the same device, removed together with the first on revoke).
- Tailscale setup in the panel: the five-step check, Start and Stop serving through `tailscale serve --bg`, the Linux operator fix command.
- Web Push for new inbox questions, alerts and blocked agents, with generic payloads.
- Isolated rig (`rig/`) with scenarios for isolation, install, link, host, panel, setup, pairing, inbox answers, terminal input and chat (the real PWA in headless Chromium against the rig's own hc).
- Protocol docs (`docs/protocol/`), SECURITY.md, RECIPE.md and the release script `scripts/release.sh`.

### Fixed

- Chat no longer loads forever: the bridge read `hc ls --json` with a guessed shape and never found hc 0.1.20's `address`, so every chat was `terminal_not_found` and never read. Every chat failure (hc missing, `hc ls` or `hc read` failing, an unknown terminal, a timeout) is now a visible message on the phone within seconds, and hc is found in `~/.local/bin` when herdr-app's PATH lacks it (`hc_missing` otherwise, also in the panel's Setup).

### Changed

- The pairing approval toast reads "Approve a new phone?" and never shows a name chosen by the phone; devices are named "Phone 1", "Phone 2" by the bridge.

- The Home Screen pairing transfer has not been tried on a real iPhone (whether iOS keeps the `start_url` fragment); see RECIPE.md.
- The `tailscale serve` handler shape, a real iPhone and push delivery are not yet verified outside the rig; see the open checks in RECIPE.md.
