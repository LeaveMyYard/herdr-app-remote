# Changelog

All notable changes. The format follows Keep a Changelog; versions follow semantic versioning once a first release is cut.

## [0.1.0] - unreleased

First release candidate: phone access to herdr-app over Tailscale. Nothing here is tagged or published yet.

### Added

- Bridge (Node >= 22, one bundled file) with the snapshot/patch hub, the `host`, `plugins`, `panorama`, `inbox`, `usage`, `chat:<t>` and `setup` topics, and loopback-only listeners.
- Mod `herdr-app-remote` for herdr-app: the 1 px link block that mirrors host state and starts the bridge, and the desktop Remote panel (Status, Devices, Plugins, Activity, Setup).
- Tab icon `mods/herdr-app-remote/remote.svg` (24 px grid, `currentColor` stroke, like the files and changes mods), installed and recorded with the mod.
- Installer `scripts/app-install` (install, upgrade, uninstall) with an install record of sha256 hashes, two derived layouts (`herdr-remote`, `panorama-remote`), and an optional panel key.
- Security layer: Host, Origin and identity guards, Funnel refusal, pairing with approval, a `__Host-` cookie, per-device capabilities (`view`, `inbox.answer`, `navigate`, `terminal.input`, `push`), rate limits, pause, and an audit log without free text.
- Phone app (PWA): Agents (Basic, and Swarm and Peek with panorama), Inbox with answering, Usage, read-only Chat, banners, Missing screens for absent plugins.
- Terminal input (`hc send`), off by default, desktop-only switch with expiry, length-only audit.
- Special keys (S16b, PR #22): a Keys sheet with a default menu (Esc, Tab, Shift-Tab, Ctrl-C, arrows) that a `data/herdr-app-remote/keys.json` list of `{label, keys}` entries replaces entirely (the defaults are used only when the file is missing or invalid) under a separate `terminal.keys` capability that is off by default, has its own expiry and a "Special keys" desktop switch, uses a strict key-token allowlist and a rate limit, and logs identifiers only.
- Phone pairing (S5b, PR #24): the `/pair#c=` screen in Safari, a dismissible "Add to Home Screen" prompt with a bell to reopen it, and the Home Screen app pairing itself on first launch through a one-time transfer code (`/pair#t=`; 10 minutes, single use, bound to the paired device, a second token for the same device, removed together with the first on revoke).
- Tailscale setup in the panel: the five-step check, Start and Stop serving through `tailscale serve --bg`, the Linux operator fix command.
- Web Push for new inbox questions, alerts and blocked agents, with generic payloads.
- Isolated rig (`rig/`) with scenarios for isolation, install, link, host, panel, setup, pairing, inbox answers and terminal input.
- Protocol docs (`docs/protocol/`), SECURITY.md, RECIPE.md and the release script `scripts/release.sh`.

### Changed

- The pairing approval toast reads "Approve a new phone?" and never shows a name chosen by the phone; devices are named "Phone 1", "Phone 2" by the bridge.

- The Home Screen pairing transfer has not been tried on a real iPhone (whether iOS keeps the `start_url` fragment); see RECIPE.md.
- The `tailscale serve` handler shape, a real iPhone and push delivery are not yet verified outside the rig; see the open checks in RECIPE.md.
