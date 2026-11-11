# herdr-app-remote

Phone access to herdr-app over Tailscale. You get your agents, your question inbox, usage and a read-only view of each terminal on an iPhone, and, only if you turn it on per phone, a way to answer questions and type into a terminal.

It has three parts:

- a **mod** that runs inside herdr-app and mirrors its state (spaces, agents, terminals) to the bridge, and draws the desktop Remote panel;
- a **bridge**, one Node process on your computer that listens on `127.0.0.1` only, talks to herdr-app, `hc` and the herdr plugins, and serves the API and the app;
- a **PWA**, the phone app, installed from Safari to the Home Screen.

```
iPhone (Safari / Home Screen app)  --HTTPS-->  tailscale serve :8443  -->  bridge on 127.0.0.1  <-->  mod inside herdr-app
```

Nothing is exposed to the internet. Only devices on your own tailnet that sign in as you can reach it. Read [SECURITY.md](SECURITY.md) before you turn it on.

## Requirements

On the computer that runs herdr-app (Linux or macOS):

- **Node >= 22** (the bridge is one bundled file and needs no `node_modules` at run time; building needs **pnpm 10** as well).
- **herdr-app**, with its `hc` command (version 0.1.19 or newer) on the PATH.
- **Tailscale** 1.52 or newer, signed in as a normal (untagged) node, with MagicDNS and HTTPS certificates turned on for your tailnet, and "serve" enabled. On Linux, run `sudo tailscale set --operator=$USER` once so the bridge may set up its serve entry.
- Optional plugins for more phone tabs: herdr-panorama (Agents and Swarm detail), herdr-inbox (Inbox) and agent-usage (Usage). A missing plugin shows a "Missing" screen on its tab; the rest keeps working.

On the phone: an iPhone with Safari, signed in to the same tailnet through the Tailscale app. Notifications need iOS 16.4 or newer and the app on the Home Screen.

## Install

```
pnpm install && pnpm build
scripts/app-install install --app-home ~/.config/herdr-app [--key ctrl-alt-r] [--node /abs/path/to/node]
```

The installer records every file it writes (with its sha256) in `data/herdr-app-remote/install.json` and refuses to overwrite anything that is not its own. It selects no layout, edits no setting and never touches `tailscale serve`. It adds:

- the mod `mods/herdr-app-remote`,
- the bridge bundle and the built PWA under `data/herdr-app-remote`,
- two layouts, described below.

`--key` binds a key (for example `ctrl-alt-r`) that opens the Remote panel, in those two layouts only. That makes `keys.json` your own file from then on: herdr-app stops adding new default shortcuts to an edited one.

After a herdr-app or panorama upgrade, run `install` again to refresh the layouts (they are copies taken at install time). Installing again with a newer checkout upgrades in place.

### Layouts

Switch to one of these in herdr-app to start the bridge. The mod's link block starts it, and it stops by itself some time after herdr-app exits.

| layout | what it is |
|---|---|
| `herdr-remote` | the shipped `main` layout plus the Remote blocks (a 1 px link block in the work column, and the Remote panel in the right-hand panel column) |
| `panorama-remote` | your installed panorama layout plus the same blocks. It is created only when panorama's `layouts/panorama.json` is exactly the one panorama's own install record describes; otherwise it is skipped and the installer says why |

The shipped `main` and `panorama` layouts are never edited. If you switch to a layout without the Remote blocks, the phone shows "Switch to a layout with Remote".

### Uninstall

```
scripts/app-install uninstall --app-home ~/.config/herdr-app [--checker /abs/path/to/herdr-app]
```

Uninstall removes only files that are unchanged since the install, and refuses while herdr-app is showing a layout that uses the mod (switch to another layout first). Files you edited are kept and listed. It does not touch Tailscale: use "Stop serving" in the Remote panel first, or run `tailscale serve --https=8443 off` yourself. Pairing and push data (`devices.json`, `activity.jsonl`, `vapid.json`, `push.json`) is not part of the install and always stays; delete `data/herdr-app-remote` by hand to forget your phones.

## Start serving and pair a phone

1. In herdr-app, switch to `herdr-remote` (or `panorama-remote`) and open the Remote panel (the key you bound with `--key`, or the Remote block in the right-hand panel column).
2. The panel shows five setup steps: Tailscale installed, signed in, HTTPS on, serving, a phone approved. Fix what it flags (it shows the command to run, and never runs it for you), then press **Start serving**. This runs `tailscale serve --bg --https=8443 http://127.0.0.1:47391`, and only when that port has no other handler.
3. In the panel, show a pairing code. It appears as a QR for `https://<your-machine>.<tailnet>.ts.net:8443/pair#c=<code>`. The code is valid for 5 minutes and works once.
4. On the iPhone, scan it with the Camera. It opens **in Safari**; the phone asks the desktop for approval.
5. The panel and a desktop toast ask "Approve a new phone?". Approve it, and the phone opens the app.
6. For notifications, add the app to the Home Screen from Safari's share sheet and turn notifications on from a tap inside the app.

*Steps 4 to 6 describe the flow of PR #24 (pending merge); main's app has no `/pair` screen yet.*

<!-- PENDING-MERGE S5b (PR #24): the /pair screen in Safari, the dismissible "Add to Home Screen" prompt, and the Home Screen app pairing itself on first launch with a one-time transfer code. Until it merges, main's PWA has no /pair screen. Update steps 4 to 6 (and confirm on a real iPhone, see RECIPE.md) when it lands. -->

An approved phone can read. Everything else is a per-phone switch you turn on from the desktop.

## Capabilities

| capability | default | what it allows |
|---|---|---|
| `view` | on after approval | reading every tab |
| `inbox.answer` | on | answering, drafting, dismissing and acknowledging herdr-inbox questions |
| `navigate` | off | focusing an agent, pane, tab or space on the desktop |
| `terminal.input` | **off**; desktop only, can expire | typing text into a terminal (`hc send`) |
| `terminal.keys` *(pending PR #22)* | **off**; desktop only, can expire | pressing special keys (Esc, Ctrl-C, arrows) from a configurable menu (`hc keys`) |
| `push` | off | web push notifications |

*`terminal.keys` and the Keys sheet are pending merge (PR #22); until then main has the first five capabilities.*

<!-- PENDING-MERGE S16b (PR #22): `terminal.keys`, the Keys sheet on the phone, keys.json and the "Special keys" desktop switch are not on main yet. Remove this note and the row above if they change shape; until the PR merges, main has only the first five capabilities. -->

Capabilities are switched in the Remote panel, per phone. A phone can never grant itself one. You can pause remote access, rename or revoke a phone at any time in the same panel; a revoked phone is cut off at once.

## What the phone shows

Agents (with Swarm and Peek when panorama is running), Inbox, Usage and a read-only Chat per terminal, with banners for connection problems (offline, not paired, paused, unavailable). See `design/` for the boards.

## Development

```
pnpm install
pnpm verify   # typecheck, lint, build, test
```

- `docs/PLAN.md`: the plan and decisions.
- `docs/protocol/`: the wire contracts ([mod-link v1](docs/protocol/mod-link-v1.md), [bridge-api v1](docs/protocol/bridge-api-v1.md)).
- [SECURITY.md](SECURITY.md): threat model and accepted risks.
- [RECIPE.md](RECIPE.md): the isolated rig, and the checks to run on a real tailnet and iPhone.
- [CHANGELOG.md](CHANGELOG.md), and `scripts/release.sh` for building a release.
- `design/`: the approved design boards and reference renders.
