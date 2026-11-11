# Changelog

All notable changes. The format follows Keep a Changelog; versions follow semantic versioning once a first release is cut.

## [0.1.0] - unreleased

First release candidate: phone access to herdr-app over Tailscale. Nothing here is tagged or published yet.

### Added

- Bridge (Node >= 22, one bundled file) with the snapshot/patch hub, the `host`, `plugins`, `panorama`, `inbox`, `usage`, `chat:<t>` and `setup` topics, and loopback-only listeners.
- Mod `herdr-app-remote` for herdr-app: the 1 px link block that mirrors host state and starts the bridge, and the desktop Remote panel (Status, Devices, Plugins, Activity, Setup).
- Installer `scripts/app-install` (install, upgrade, uninstall) with an install record of sha256 hashes, two derived layouts (`herdr-remote`, `panorama-remote`), and an optional panel key.
- Security layer: Host, Origin and identity guards, Funnel refusal, pairing with approval, a `__Host-` cookie, per-device capabilities (`view`, `inbox.answer`, `navigate`, `terminal.input`, `push`), rate limits, pause, and an audit log without free text.
- Phone app (PWA): Agents (Basic, and Swarm and Peek with panorama), Inbox with answering, Usage, read-only Chat, banners, Missing screens for absent plugins.
- Terminal input (`hc send`), off by default, desktop-only switch with expiry, length-only audit.
- Tailscale setup in the panel: the five-step check, Start and Stop serving through `tailscale serve --bg`, the Linux operator fix command.
- Web Push for new inbox questions, alerts and blocked agents, with generic payloads.
- Isolated rig (`rig/`) with scenarios for isolation, install, link, host, panel, setup, pairing, inbox answers and terminal input.
- Protocol docs (`docs/protocol/`), SECURITY.md, RECIPE.md and the release script `scripts/release.sh`.

### Changed

- The pairing approval toast reads "Approve a new phone?" and never shows a name chosen by the phone; devices are named "Phone 1", "Phone 2" by the bridge.

### Pending merge

<!-- PENDING-MERGE S5b (PR #24) and S16b (PR #22): move these two entries up into Added when the PRs merge, or edit them to match what merged. -->

- S5b: the `/pair` screen in Safari, a dismissible "Add to Home Screen" prompt, and the Home Screen app pairing itself on first launch with a one-time transfer code (PR #24).
- S16b: a special-keys menu (Esc, Ctrl-C, arrows and more, from `data/herdr-app-remote/keys.json`) under a separate `terminal.keys` capability, off by default (PR #22).

### Known issues

- Until S5b merges, the phone app has no `/pair` screen, although the bridge's pairing API exists and is tested.
- The `tailscale serve` handler shape, a real iPhone and push delivery are not yet verified outside the rig; see the open checks in RECIPE.md.
