# herdr-app-remote: implementation plan

Status: approved direction, 2026-11-11. Decisions in §7.
Design: approved 2026-11-11; the boards are copied into `design/` in S1.

Sources:
- the spike `~/Code/herdr-web/SPIKE.md` and its `rig/`;
- the design boards and their generator `design/work/common.py`;
- herdr-app's `herdr.d.ts`, `AGENTS.md` and `layouts/*.json`;
- herdr-inbox `docs/protocol/app-{feed,commands}-v1.md`;
- herdr-panorama `app/` (on origin/main since #195);
- agent-usage `docs/collect-json-v1.md`.

## 0. Facts that shape the plan

**Layouts we can't edit in place**
- `main` is a shipped, read-only layout. If you edit `layouts/main.json`, the app moves it to `main-edited` on the next start.
- `layouts/panorama.json` is hash-pinned in panorama's install manifest. If we patch it, panorama's uninstall says "changed; preserved" and its upgrades refuse.

**Where the mod can live**
- A hidden node never starts its mod ("a copy starts the first time it shows"). The `panel` column and the `sidebar` can be hidden.
  - So the 1px link block must sit in an always-shown node (the `work` column).
  - The Remote panel is a second copy of the same mod in `panel-body`.
- Floating blocks get a frame and can be dragged, so they can't hold the link.

**Plugin facts**
- The usage command is `usagebar collect --format v1`.
- `usagebar notify --json` consumes toasts. If two callers use it, they split the toasts (see §7 Q4).
- The inbox writer is started only by the herdr-inbox overlay mod.
  - The bridge may run `herdr-inbox app-feed --ensure` through the launcher, under the protocol's own rules: after the `app --help` probe, and at most once per 5 s while stale.
- The panorama writer may be ensured only by the lease owner (`shared("panorama.feed.owner")`), so the bridge never runs it.
  - Rich Agents and Swarm data is therefore fresh only while a panorama owner runs in the app. Otherwise the phone shows Basic Agents.

**Reuse, don't reimplement**
- Plugin logic we can reuse from the installed mods, hash-checked against each plugin's own `install.json`:
  - panorama `contract.js`;
  - inbox `feed.js`, `commands.js` and `model/*`, if these turn out to be import-free (confirmed in S7).
- Design tokens are in `design/common.py`: `T`, `DOCK`, `SURFACE`, `STATES`, `GLYPHS`, `ICON` and `CSS`. Reference renders come from `render.sh`.

## 1. Architecture

```
 iPhone (Home Screen PWA)          desktop (Linux/macOS)
 ┌──────────────┐  HTTPS+WSS   ┌───────────────────┐  HTTP+WS  ┌──────────────────────────────────┐
 │ React PWA    │─────────────▶│ tailscale serve   │──────────▶│ herdr-app-remote bridge (Node)   │
 │ SW: shell    │  tailnet     │ :8443             │ 127.0.0.1 │  api :P1 (PWA, static, /api/v1)  │
 │ Web Push     │◀─ push svc ──│ adds Tailscale-*  │           │  link :P2 (mod, NDJSON, token)   │
 └──────────────┘              └───────────────────┘           │  adapters ─┬─ panorama feed.json │
                                                               │            ├─ inbox feed + app verbs
 herdr-app (GPUI)                                              │            ├─ usagebar collect --format v1
 ┌───────────────────────────────┐  net.connect TCP :P2        │            ├─ hc ls/read/events/send
 │ mod herdr-app-remote          │◀───────────────────────────▶│            ├─ tailscale status/serve
 │  role=link  (1px block, work) │  state out / commands in    │            └─ herdr-app status / do
 │  role=panel (panel-body stack)│                             │  state: devices, audit, push subs
 └───────────────────────────────┘                             └──────────────────────────────────┘
   the link copy starts the bridge with: exec sh -c "setsid node <bundle> … </dev/null >/dev/null 2>&1 &"
```

**Bridge language: Node/TypeScript (recommended).**
- It can run the plugins' own pure JS validators, so nothing is ported.
- The PWA, mod and bridge share one set of protocol types.
- The spike's sidecar, shim and rig code is already Node.
- Cost: Node ≥22 becomes a runtime dependency. The bridge ships as one esbuild bundle with no `node_modules`. Its sha256 is recorded in our `install.json` and verified by the link mod before each launch, the same pattern as panorama's `binary.js`.

## 2. Security model

**Binding and request guards**
- Both listeners bind to `127.0.0.1` only. The tailnet reaches them only through `tailscale serve --bg --https=<port> http://127.0.0.1:P1`.
- Funnel is never used. The bridge refuses to run while Funnel is on its port.
- The `Host` header must equal the serve name (DNS-rebinding guard).
- `Tailscale-User-Login` is required and must equal the desktop owner's login.
  - It is a precondition, never the credential: any local process can forge it on 127.0.0.1.
  - Tagged devices send no identity headers, so they are refused.

**Pairing**
1. The desktop panel shows a QR for `https://<serve>/pair#c=<code>`. The code is 128-bit, valid for 5 min and single use.
2. The phone opens it in Safari and posts the code (operator flow change, 2026-11-11: pairing happens in Safari).
3. The device becomes pending, and the desktop panel and a toast ask "Approve a new phone?" (the toast never carries a device name).
4. The phone gets a `__Host-` cookie (`HttpOnly; Secure; SameSite=Strict`) holding a random 256-bit token when it pairs, as a `pending` device. The cookie grants nothing until the desktop approves the device. Only its sha256 is stored, in `devices.json` (0600).
5. Devices can be revoked or renamed. A revoked device is dropped live.
6. Safari then offers to add the app to the Home Screen (dismissible, again from a bell). iOS keeps the Home Screen app's storage apart from Safari's, so the bridge mints a one-time transfer code (128-bit, 10 min, single use, bound to the approved device) over Safari's socket and puts it only in that device's manifest `start_url` (`/pair#t=<code>`). On first launch the Home Screen app spends it for its own second token of the same device (revoke removes both), with no second approval (S5b; `docs/protocol/bridge-api-v1.md`, "Home Screen transfer").

**Capabilities per device** (checked on the bridge for every action)

| capability | default | covers |
|---|---|---|
| `view` | on after approval | all read topics |
| `inbox.answer` | on | inbox verbs only: draft, answer, dismiss, ack, retry, stop-showing |
| `navigate` | off | allowlist: `agent.focus`, `tab.select`, `space.select`, `pane.focus` |
| `terminal.input` | **off**; desktop-only toggle, can expire | `hc send` |
| `terminal.keys` | **off**; desktop-only toggle, can expire | `hc keys`, only the entries of the desktop's key menu (S16b) |
| `push` | off | push subscriptions |
| `transcript.read` (chat view, CV1) | **off**; desktop-only toggle | the `chatview:<t>` and `timeline:<t>` topics and chat history pages |
| `prompt.answer` (chat view, CV7) | **off**; desktop-only toggle, expires | `prompt.answer` and `agent.stop` |

There is no generic `run`, no `exec`, and no arbitrary `herdr-app do`. Anything else is refused and logged.

**Origin, CSP and secrets**
- The WS upgrade and every non-GET request need `Origin == https://<serve>` and the cookie. Non-GET requests also need `X-Remote-Api: 1`; the WS upgrade instead needs the subprotocol `herdr-remote.v1`, because browsers can't set headers on it (S5).
- GETs have no side effects.
- CSP: `default-src 'self'`, with no inline script. Fonts are self-hosted.
- Terminal and feed text is rendered as text, never as HTML.
- The PWA holds no secrets. Inbox row tokens stay on the bridge, keyed per row.

**Mod link authentication**
- The bridge writes `data/herdr-app-remote/runtime.json` (0600) with `{v, port, token, pid, bundle_sha256}`.
- The mod sends the token in its `hello`. Only one live link is kept: the newest valid hello wins.

**Audit and pause**
- `activity.jsonl` (0600, rotated) feeds the Activity tab.
  - It never stores free text or terminal input; an entry reads like "sent 12 chars to t3".
  - Option labels are logged, as the design shows.
- Pause refuses everything except `/healthz`. "Stop serving" removes only our own serve handler.

## 3. Protocols (`docs/protocol/`)

### `mod-link-v1`

NDJSON over TCP, one JSON object per line.

Mod to bridge:
- `hello {v:1, token, copy, layout, app:{version}}`.
- `state {seq, host:{spaces, agents, terminals, panes, focused, theme, layout_name, shared:{panorama.feed.owner}}}`.
  - Sent from `render()`, deduplicated by a hash of its content, at most once per 100 ms.
- `result {id, ok, error?}`.

Bridge to mod:
- `run {id, name, args}`, from the allowlist only. The mod checks the allowlist again itself.
- `notify`.
- `ping`.

The mod closes the socket in `close()` and reconnects with backoff from 0.5 s to 10 s.

### `bridge-api-v1`

- `GET /api/v1/meta` returns the API and bridge versions.
- WS `/api/v1/ws`:
  - The client sends `hello {api, resume?}`, `sub {topics}`, `act {id, kind, args}` and `ping`.
  - The server sends `welcome`, `snap`, `patch` (RFC 6902), `stale {reason}`, `res {ok, code, unknown_effect}` and `event`.
- Topics: `host`, `plugins`, `panorama`, `inbox`, `usage` (polled every 15 s, only while subscribed), `chat:<t>`, `setup`.
- Each bridge start gets a random epoch. An unknown epoch or a seq gap gets a fresh `snap`.
- iOS kills background sockets, so the PWA reconnects on `visibilitychange` and `online`. There is no optimistic UI.

**Plugin states:** `ready`, `missing`, `too_old`, `broken`, `stale`, `not_running`.

| plugin | how it's detected |
|---|---|
| panorama | install receipt, `contract.js` hash, feed `v == 2` |
| inbox | `app --help` first line is `herdr-inbox app v1` |
| usage | `usagebar collect --format v1` |
| hc | `hc --version` |
| host | the link, or `herdr-app status` |

**Action results:** a non-zero exit outside the contract, or bad stdout, counts as `unknown_effect`. The PWA says so and refreshes, and never retries by itself.

**Layout switch:**
1. The link closes and the `host` topic goes stale with reason "reconnecting". The last state stays on screen.
2. A new hello sends a fresh `snap`.
3. If no hello arrives within 5 s and the shown layout has no link block, the reason becomes `layout_without_remote`, and the phone shows "Switch to a layout with Remote".

## 4. Repo, build, install, CI

```
packages/protocol/   TS types + zod schemas (mod-link v1, bridge-api v1)
packages/bridge/     server, ws hub, link, adapters/{panorama,inbox,usage,hc,tailscale,app}, security, audit, push
packages/pwa/        Vite + React + TS; design tokens generated from design/common.py
mod/herdr-app-remote/  main.js (role switch), link.js, panel/*.js, mod.json {"place":"none"}
installer/           scripts/app-install (Node, mirrors the inbox semantics)
design/              *.dc.html, common.py, refs/*.png
fixtures/            fake data only
rig/                 ported from herdr-web/rig, plus e2e scenarios
docs/protocol/, SECURITY.md, RECIPE.md
```

**Toolchain:** pnpm, TS strict, Vitest, Testing Library, Playwright (WebKit and Chromium), esbuild, Vite.

**Installer** (`scripts/app-install install|uninstall --app-home ABS`):
- The manifest (`install.json`) records each file's sha256 and mode. Files are staged and swapped in atomically.
- It refuses collisions.
- Uninstall removes only files that are unchanged, and refuses while the app is showing a layout that uses the mod.
- It never selects a layout, edits settings, or touches `tailscale serve`.
- It creates two derived layouts:
  - `herdr-remote.json`: a copy of the shipped `main` with the link block (the last child of `work`, 1 px) and the panel block (in `panel-body`) added.
  - `panorama-remote.json`: the same two blocks added to the installed `panorama.json`, but only if that file's hash matches panorama's receipt. Panorama's sidebar stays the feed owner.
- Optional `--key ctrl-alt-r` opens the Remote panel.

**CI:**
- typecheck, lint, unit tests and contract tests;
- PWA component tests;
- Playwright visual tests against `design/refs` (WebKit 390×844, Chromium 1280×800);
- installer tests in temp homes;
- shim smoke render of the mod.

The rig e2e needs herdr-app, hc, bwrap and mutter, so it runs locally: `pnpm rig`. It is required before merging any safety-critical PR.

## 5. Testing

- **Unit tests:** patch engine (resume, epoch), capabilities, Host/Origin/cookie guards, pairing state machine, audit redaction, allowlist, link dedupe.
- **Contract tests:**
  - zod schemas round-trip every fixture.
  - Adapters run against the plugins' own fixtures. These are copied in with a source sha, and a drift script compares them with the sibling checkouts.
  - Fake CLIs (`hc`, `usagebar`, `tailscale`, `herdr-app`, the inbox launcher) replay recorded outputs, including too-old and error variants.
- **Mod tests:** `link.js` runs under the herdr-web shim against a fake TCP bridge.
- **PWA tests:**
  - Testing Library tests per screen, with fake data.
  - Playwright + pixelmatch against the design renders: at most 0.5% of pixels may differ, with animations masked.
  - A token test asserts the tokens equal `common.py`.
- **Isolated rig e2e:**
  - Setup: bwrap with `/run/user` and the live `~/.config/herdr-app` hidden; private pid, net and /proc; private HOME, XDG and `HERDR_APP_HOME`; a unique `HC_SESSION`; bound at `/mnt/r`; headless mutter. It never touches the live app.
  - Scenarios:
    - install;
    - layout switch, the link starting the bridge, a host snapshot and a `tab.select`/`space.select` roundtrip (`tab.new` stays off the allowlist);
    - `layout_without_remote`;
    - a terminal delta;
    - fake feeds;
    - a Playwright phone through a stand-in for serve that injects `Tailscale-User-Login`;
    - pairing, an inbox answer through a stub launcher, and the audit entry.

## 6. Slices / PRs

Tiers: **SC** = safety-critical (full review-cycle plus a fresh final reviewer plus a green rig run), **N** = normal, **D** = docs. ∥ = can run in parallel with.

| # | Slice | Depends | ∥ | Tier |
|---|---|---|---|---|
| S1 | Skeleton + contract types | – | – | N |
| S2 | Link mod + bridge link server | S1 | S3, S4, S6 | SC |
| S3 | Rig port | S1 | S2, S4, S6 | N |
| S4 | Bridge hub + host topic | S1 | S2, S3, S6 | N |
| S4b | Bridge bootstrap + PWA client | S4, S6 | – | N |
| S5 | Security: pairing, devices, guards, audit | S4 | S7 | SC |
| S5b | PWA pairing screen (`/pair`), banners | S5, S6 | – | SC |
| S6 | PWA shell, tokens, visual harness, Basic Agents, Missing | S1 | S2–S5 | N |
| S7 | Plugin detection + `plugins` topic | S4 | S5, S6 | N |
| S8 | Panorama adapter + Agents/Swarm/Peek | S6, S7 | S9, S10, S12 | N |
| S9 | Usage adapter + screen | S6, S7 | S8, S10, S12 | N |
| S10 | Inbox read | S6, S7 | S8, S9, S12 | N |
| S11 | Inbox answer | S5, S10 | S12–S14 | SC |
| S12 | Installer + derived layouts | S2 | S8–S11 | SC |
| S13 | Desktop Remote panel | S5, S7, S12 | S11, S14 | N |
| S14 | Tailscale setup + serve control | S5, S13 | S15 | SC |
| S14b | Panel Setup wiring (check/start/stop in the panel channel) | S13, S14 | – | SC |
| S15 | Chat, read-only | S4, S6 | S11–S14 | N |
| S16 | Terminal input | S5, S13, S15 | – | SC |
| S16b | Special keys menu (`hc keys`) | S16 | S17 | SC |
| S17 | Web Push | S5, S10, S13 | S16 | SC |
| S18 | Docs + release | all | – | D |
| Copy | Copy PR: apply the approved `design/COPY.md` rows not owned by S5b or S16b | S4b, S14 (the Docs PR with `design/COPY.md`) | S5b, S16b | N |
| U1 | (panorama repo, optional) feed-client `viewer`/keepalive role | – | any | SC there |
| CV1 | Chat view: capability `transcript.read` (devices.json field, panel switch, Activity) | S5, S13 | CV2 | SC |
| CV2 | Chat view: Claude reader (agent-usage profile roots, per-root SDK child, pinned SDK, rig test) | S4 | CV1, H0 | SC |
| CV3 | Chat view: `chatview:<t>` topic (panorama join, tail, diff, limits, redaction, GET pages) | CV1, CV2 | – | SC |
| CV4 | Chat view: PWA chat screen (Claude: chat only; text view for Codex and fallbacks) | CV3 | CV5 | N |
| CV5 | Chat view: `timeline:<t>` plus inline inbox items and panorama strip | CV3, S11 | CV4 | SC |
| CV6 | Chat view: agent-usage chip (per-pane account) | CV5 | – | N |
| H0 | Chat view: rig records Claude Code's prompt blocks for the pinned version | S3 | CV1–CV3 | N |
| CV7 | Chat view: `prompt.answer` (capability, parser, two-phase press, cards) | CV3, H0 | CV4, CV5 | SC |
| CV8 | Chat view: `agent.stop` and Stop in the composer | CV7 | – | SC |
| CV9 | Chat view: AskUserQuestion with several questions answerable (one card, one Submit); fixtures moved to Claude Code 2.1.325 | CV7 | – | SC |
| I1 | (herdr-inbox repo) app-feed: answered rows, `tool_use_id` | – | any | SC there |
| H1 | Later: log-only Claude plugin hook as a fourth prompt signal | CV7 | – | SC |
| C1 | Later: Codex chat through `codex app-server` | CV3 | – | N |
| H2 | Request for main to raise with the herdr owners: `hc keys --no-wait` / `--if-screen`. Not a dependency | – | – | SC there |

Critical path: S1 → S4 → S5 → S11 → S13 → S14 → S16/S17. S2, S3, S6 and S7 start right after S1.

**S1 Skeleton + contract types**
- Goal: the workspace, CI, the protocol package, both protocol docs, host fixtures and design copies.
- Accepts: `pnpm -r build test` is green, and every fixture validates.

**S2 Link mod + bridge link server**
- Goal: the link mod mirrors host state and runs allowlisted commands. The bridge's link server checks the token and keeps a single link.
- Accepts:
  - dedupe and coalescing hold;
  - `close()` closes the socket;
  - reconnect backoff works;
  - the allowlist is enforced at both ends.
- Tests: shim tests and a fake TCP bridge.

**S3 Rig port**
- Goal: a generic rig with scripted scenarios.
- Accepts: the ABORT guards are kept, and the host scenarios pass.

**S4 Bridge hub + host topic**
- Goal:
  - static server and WS hub;
  - the snap/patch engine with epoch and resume;
  - the `host` topic, with stale and `layout_without_remote` reasons.
- Accepts: a seq gap yields a snap, and a 1 MiB topic patches in under 10 ms.

**S5 Security**
- Goal:
  - Host, Origin and identity guards;
  - pairing code and QR SVG, pending → approved;
  - the `__Host-` cookie and `devices.json`;
  - capability middleware;
  - the audit log with redaction;
  - pause.
- Tests: attack cases (Host spoof, missing identity, wrong login, replayed code, CSRF, tagged device).

**S6 PWA shell**
- Goal:
  - Vite + React, with tokens and glyphs from `common.py` and self-hosted fonts;
  - the manifest and icons, with safe-area handling;
  - icon policy: the app source and the release bundle ship only the neutral icons, at fixed paths (`icons/favicon.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `app-logo.png`). The installer renders the herdr-app icon from the local herdr-app install (PR #32: the operator's own `herdr-app.svg` next to the `herdr-app` binary, or `--icon`), replaces those files in the installed PWA, records it in the install record, and says so in one line when it keeps the neutral ones. herdr-app is Apache-2.0 and §6 grants no trademark rights. Commits from ee8c8c0 (#1) up to 896b8f8 (#13, which removed it; includes 14961b0) still contain herdr art, and the design reference screenshots in `design/refs/` that showed the app header (8 of the 14) were re-rendered with the neutral `remote.svg` icon; the other 6 never showed it (the current tree has no herdr art). The operator decided on 2026-11-12 (Q472) to leave the git history unchanged;
  - the 5-tab bar with badges;
  - connection and stale banners;
  - the PhoneAgentsBasic and PhoneMissing screens;
  - the visual test harness.
- Accepts: both boards within the threshold, and it installs to the Home Screen in standalone mode.

**S7 Plugin detection**
- Goal: one probe per plugin, hash-pinned loading of the plugins' JS, and minimum-version constants.
- Accepts: every state comes out of the fake CLIs.

**S8 Panorama**
- Goal:
  - read the feed, validated by panorama's own `contract.js`, with a 15 s staleness rule, keeping the last good feed;
  - join it with the host's `agents()`;
  - fall back to Basic Agents when there is no lease owner.
- Screens: PhoneAgents, PhoneSwarm, and PhonePeek (feed fields only).
- Accepts: three boards within the threshold, and a feed error never shows an empty swarm.

**S9 Usage**
- Goal: `usagebar collect --format v1 --panes <JSON>`, run only while subscribed, every 15 s, with a 10 s timeout. PhoneUsage.
- Accepts: `too_old` shows the Missing screen.

**S10 Inbox read**
- Goal:
  - the feed, following all of its reader rules;
  - `app show` for omitted ids;
  - writer `--ensure` at most once per 5 s while stale;
  - PhoneInbox.

**S11 Inbox answer**
- Goal:
  - draft, answer, dismiss, ack, retry and stop-showing, through `herdr-inbox app <verb> --json`;
  - tokens held on the bridge;
  - the inbox's own arm delays for touch;
  - unknown effect handled as the protocol says;
  - every action audited.
- Screens: PhoneQuestion, PhoneReview, plus the two PhoneInbox parts S10 leaves out: the closed-row "delivered" placeholder (row 4) and the footer line with its "Seen" button (operator via conductor, S10 review).

**S12 Installer + derived layouts**
- Goal:
  - the installer from §4;
  - bundle hash verification;
  - detached launch, made single-instance with `flock`;
  - idle-out when the app is gone.
- Accepts:
  - install, upgrade and uninstall are idempotent;
  - collisions are refused;
  - shipped and panorama files are hash-asserted unchanged;
  - nothing is selected.

**S13 Desktop Remote panel**
- Goal: GPUI views for Status, Devices, Plugins and Activity, approve and revoke, capability toggles, and the panel key.
- Accepts: `herdr-app check` passes in the rig, and the panel matches the board side by side.

**S14 Tailscale setup + serve**
- Goal: the 5-step checks, and "Start serving" with `tailscale serve --bg`.
  - It refuses if a port has a handler that is not ours.
  - It detects the Linux operator-permission error and shows the exact command to fix it.
- Accepts: a serve config we did not create is never changed.

**S4b Bridge bootstrap + PWA client** (merged; Normal tier, reviewed with an opus author because of its security-adjacent surface)
- Goal: the bridge entry point and the PWA client that connects the topic drivers to the screens, which until then ran on `?fixture=` data.

**S5b PWA pairing screen** (merged; design approved 2026-11-11: `design/PhonePair.dc.html`, `PhoneBanners.dc.html`)
- Goal:
  - Safari pairs at `/pair#c=<code>`; the screen follows the board states (checking, waiting, approved, expired);
  - then a dismissible "Add to Home Screen for notifications" prompt, with a bell to reopen it;
  - the Home Screen app pairs itself on first launch with a one-time transfer code in the manifest `start_url` (`/pair#t=<code>`): short TTL, single use, bound to the paired device;
  - the connection banners use the strings in `design/COPY.md` (replacing the provisional ones in `Banner.tsx`).
- Accepts: socket-level tests for the transfer code (replay, expiry, wrong device); verified once on a real iPhone, and the result recorded (OPEN: the real-iPhone check is not done; see RECIPE.md).

**S14b Panel Setup wiring** (merged)
- Goal: `setup.check`, `setup.start` and `setup.stop` on the panel channel, so the Remote panel gets its Start serving button; the Security change chains `setup.refreshPhone()`.

**S15 Chat, read-only**
- Goal: `hc ls`, `hc read`, and `hc events` if the rig proves it (otherwise 1 s polling); ANSI → spans; the inbox banner.

**S16 Terminal input**
- Goal:
  - the `terminal.input` capability, off by default, with optional expiry;
  - `hc send`;
  - the key bar, only for keys `hc send` supports;
  - a confirmation on the first send;
  - a rate limit;
  - audit entries that record only the length.

**S16b Special keys menu** (merged; design approved 2026-11-11: `design/PhoneKeys.dc.html`)
- Goal:
  - a separate phone menu opened from the key bar, sending Esc, Ctrl-C, arrows and the like through `hc keys`;
  - a separate capability, off by default, with its own desktop "Special keys" switch that mirrors the Typing row exactly (1 hour / 8 hours / No limit);
  - the set comes from `data/herdr-app-remote/keys.json` (not herdr-app's own keybinding `keys.json`), a list of `{label, keys}` with sensible defaults, shown as "Your keys";
  - the typing-time line (amber under 10 minutes) and the ran-out footer follow the board.
- Accepts: audit entries record the label only; a key the config does not list is refused at the bridge.

**S17 Web Push**
- Goal:
  - VAPID keys;
  - subscribing inside the Home Screen app, from a user gesture;
  - triggers: new inbox questions and alerts, and an agent turning blocked;
  - generic payloads;
  - no announcements after a restart.

**Copy PR** (merged)
- Goal: apply every `●` row of `design/COPY.md` not owned by S5b, S16b or the chat view slices (CV*) (push bodies kept, first-send note, send refused, notifications row, the Dismiss confirm bar with [Keep] [Dismiss]). "desk-1" is the Tailscale machine name from the serve identity, falling back to the hostname. Whichever of S5b and this PR lands first adds the host name to the PWA; the other reuses it.

**S18 Docs + release**
- Goal: README, SECURITY.md, RECIPE.md, final protocol docs, CHANGELOG, and the release script.

**U1 (panorama repo, optional)**
- Goal: a feed-client viewer role, so the feed stays fresh in layouts without panorama.

**Chat view (CV1-CV8, H0, I1)** (design and spec approved 2026-11-13: [`docs/chatview.md`](chatview.md), board `design/PhoneChatView.dc.html`, copy rows in `design/COPY.md`)
- Goal: for Claude Code agents the phone shows the conversation as chat, the only view (no terminal toggle, key bar or Keys menu). Native prompts are cards. Codex and unsupported harnesses keep the text view.
- Config roots come only from herdr-agent-usage's profile list. Without it, Claude agents show the text view with a notice (`no_profiles`).
- **CV1** Accepts: SECURITY.md updated (capability row); `transcript.read` is off by default with its own desktop switch; `devices.json` schema change with no downgrade (a defaulted field in the strict schema, as S16b did; `v` stays 1); topics refuse without it.
- **CV2** Accepts: one reader child per distinct `projects` root, pinned SDK, no `~/.claude*` scan and no `CLAUDE_CONFIG_DIR` source; the rig test fails on a shape change.
- **CV3** Accepts: the session is bound only through panorama's proved join; an aged or stale feed hides the chat; secrets are redacted; the snap stays under 512 KB. Note from the CV1 review: CV1's gate writes only refusals to Activity, so CV3 writes the granted open ("Phone 1 opened the chat of t3", once per subscription, §5.3) and decides whether a granted transcript `sub` is refused while Activity can't be written (`audit_unavailable`, as `terminal.send` is). Also (from the CV2 review): before the first spawn the pool checks that `claude-reader.mjs` is the one built with `bridge.mjs` (e.g. its sha256 injected into the bundle at build time), and a mismatch fails as `spawn`; a read that is `not_found` while `root.transcript` has a size > 0 is `reader_failed`, not "No messages yet".
- **CV4** Accepts: (from the CV3 review: `GET /api/v1/chatview/<t>` needs the `X-Remote-Api: 1` header; markdown from `text` only through the whitelist renderer) (note from the CV1 review: `stale` normally means "last value stays", but on `stale` reason `forbidden` for `chatview:<t>`/`timeline:<t>` the PWA drops the history it holds instead of showing it dimmed) (note: the board lacks states for the unparsed-prompt card and the `no_profiles` notice; draw them during CV4/CV7; the `no_profiles` notice must tell the user to add their Claude account as a profile in herdr-agent-usage, since a config with no `[[claude.profiles]]` is `no_profiles` too) bubbles, safe markdown (no raw HTML, no images), tool rows, jump to latest, older pages; Claude has no terminal toggle; every §6 fallback shows the text view with its notice.
- **CV5** Accepts: (from the CV3 review: a granted `timeline:<t>` open is audited once per subscription, as `chatview:<t>` is) inbox questions, alerts and failures appear inline with their existing acts; the panorama strip links to Swarm and Peek; an unknown kind renders from its fallback fields.
- **CV6** Accepts: the pane's account chip comes from the usage topic.
- **CV5b** Accepts: the live chat view wants `timeline:<t>` with `chatview:<t>`, places its items with `placeTimeline` (a row that moves keeps its in-flight act), draws the strip under the header (Aa on the strip row in a Claude agent's fallback text view), acts through the Inbox's own path; a refused timeline never breaks the chat. **Operator-approved deviation (Q528, 2026-11-13: "Claude only for now"):** the board's "Codex" state draws the strip in Codex's text view, but the strip and the inline inbox items appear for Claude agents only. Codex keeps the plain text view until real Codex chat support (C1). (`timeline:<t>` needs `transcript.read` and records a chat open in Activity.)
- **H0** Accepts: rig fixtures for the permission, AskUserQuestion (single, multi, Other) and plan blocks of the pinned Claude Code version; transcript-before-dialog ordering verified; multi-select toggle keys recorded.
- **CV7** Accepts: SECURITY.md updated (capability row and the R6 accepted risk); `prompt.answer` is off by default with an expiry; cards need T, S and V to agree; every shown option, including "Yes, and don't ask again" and the auto-mode plan option, is pressable; AskUserQuestion answers only on its Answer button; arrows only; two-phase check and post-check; an unparseable prompt shows its screen lines read-only plus "Answer it on desk-1"; a mismatch never presses. **Decision (main, H0 review): `hc send --force` is allowed ONLY in the Other-answer path**, only after (1) the two-phase check has moved the cursor to the prompt's own Other field and (2) a fresh `hc read` confirms the same prompt with that field active, matched against the H0 recording (`fixtures/claude-prompts/`); never for composer sends, Stop or option presses; unconfirmed => refuse "The prompt changed. Look again.". CV7 must amend spec §3a.4 step 5, SECURITY.md:60 and the "never --force" comment in `terminal/send.ts` accordingly, check in the rig that `--force` still waits for an unfinished desk draft, and have a test that `--force` is unreachable from every other path. Multi-select + Other is not recorded (H0 manifest): refuse `{other}` on a multiSelect question until it is.
- **CV8** Accepts: Stop presses Esc once, only while working and with no card open, with a 3 s cooldown; covered by `prompt.answer`.
- **CV9** Accepts: the rig records Claude Code's tabbed question UI first (`rig/scenarios/claude-multiq.sh`: tabs and the keys between them, Enter on an option, ticks and Next/Submit, Other per question, the review, Esc at a question and at the review; manifest `multiQuestion`) and the fixture pin moves to the installed 2.1.325 (the H0 and CV8 screens re-recorded: only the banner and timings changed); a card with several questions is one block per question and one Submit (`{answers}`), answered by walking the tabs one checked press at a time, the review checked before the last Enter; `--force` stays only on the Other path, per question after its own field is confirmed. Multi-select with Other and the `other` permission prompts (MCP tools, Edit/Write) are not in CV9: see the follow-ups.
- **I1** (herdr-inbox repo) Accepts: the app-feed publishes recently answered rows and records the `ask_operator` `tool_use_id`.
- H1 (hook signal) and C1 (Codex) are later. H2 is a request main raises with the herdr owners; no slice depends on it.
- **Residual risk (prompt.answer).** `hc keys` waits up to 15 s for the desk to go quiet before pressing, so the screen can change between the last read and `enter`. CV7 ships anyway with the two-phase check (arrows, re-read, `enter`, post-check), behind `prompt.answer`, which is off by default and expires. The risk is recorded in `docs/chatview.md` (§3a.5 R6, §9) and SECURITY.md (accepted risks) and is closed only if H2 (`--if-screen`) lands. Measured in the rig by CV7 (hc 0.1.20, `rig/scenarios/prompt-answer.sh`): an unfinished desk draft (a person typing through `hc attach`) held `hc send --force` for 60 s, after which hc pasted the text after the draft; the bridge's 15 s timeout kills hc first (unknown effect), and the killed send did not land.
- **CV7 follow-ups (after review).** (1) AskUserQuestion with several questions: done in CV9 (one block per question, one Submit; the askm stepper is replaced, a named deviation). (2) Multi-select with Other: recorded in CV9 (typing on its row ticks the box, Enter toggles it, a paste plus Enter leaves it unticked), still refused: it needs a key sequence of its own (next slice). (3) "Skip" on the question card (operator Q521, 2026-11-13: "Next question only") moved to the next question of the stepper; with CV9's one block per question there is nothing to skip to, so it is gone. (6) The permission prompts of other tools (MCP tools, Edit/Write file permissions) are not recorded and not in CV9 (an MCP permission has Bash's title "Do you want to proceed?", so it shows read-only); recording them and answering them by option is the slice after CV9. (4) Wiring with CV4: done in CV7 (it landed second): `Items.tsx` draws role `prompt` with `PromptCard` (`ItemCtx.prompt` carries the terminal, the desk name and the act), ChatView adds `PromptTail` before its tail, locks the composer and hides "Waiting for you" while a card is open, and LiveApp sends `prompt.answer` through `client.act`. The rig asserts that a send killed at 15 s did not land later (hc 0.1.20). (5) Final pass: a phase B press or Other send that hc held over 1 s is `unknown_effect` (the desk may have answered first; the rig asserts it with a desk answering through `hc attach`); Other text starting with `!`, `/` or `#` is refused; `terminal.send`/`terminal.keys` into a terminal are `busy` while an answer runs there.

## 7. Decisions (operator, 2026-11-11)

1. The repo is **public** from the start.
2. **Terminal input ships in v1** (S16). It is off by default per device, turned on from the desktop, and audited.
3. **Push shows question titles** (for example "Agent 1: Question Title 123").
4. **The bridge is Node ≥22.**

Defaults taken until the operator says otherwise:

5. No usage-limit pushes in v1. The bridge never calls `usagebar notify --json`.
6. A derived `panorama-remote` layout.
7. The bridge idles out with the app.
8. Serve port `:8443`.

## 8. Unverified risks

- **Deferred (CV6 follow-up; CV5b wired the strip):** a Claude agent's fallback text view now shows the strip with the chip and Aa on its row. Codex's text view has no strip, so no chip, until C1 (operator, Q528; CV5b deviation above). A pane that used no account in the report's window has no chip, so a fresh session shows none until it has been used.
- **Deferred (CV5 follow-ups from the #48 final review):**
  - **M2, stale sources.** `TimelineTopicDriver.refresh` never checks `hub.isStale` for `host`, `inbox` or `panorama`. A stale `host` still decides which herdr-tui askers belong to t and which agent the strip joins. A stale `inbox` still publishes rows with live answer buttons; the acts are refused server-side, but the phone gets no stale signal. Fix: treat a hub-stale `host` as null (no herdr-tui match, no strip) and a hub-stale `panorama` as no strip, and either drop inbox items while `inbox` is stale or pass `stale` through to `timeline:<t>`.
  - **L2, parse per timeline.** `refreshAll` re-parses the full `inbox`, `panorama` and `host` values once per open timeline on every change to any of them. Parse once per `refreshAll` and pass the parsed values in.
- **Deferred (known tech debt, not a risk; #33 follow-up):** the bridge's `--panes` label, empty-key handling and cwd differ from the desktop agent-usage panel, so per-pane shares can differ. The operator chose "defer as tech debt" (Q473); it is recorded here instead of a GitHub issue.
- **hc:** `hc events` hasn't been tested against a live core. `hc send` was checked in the rig (S16, hc 0.1.19): it pastes text and presses Enter, and has no special keys, so the key bar's own keys are text-only: ⏎ and `/`. Special keys are `hc keys` (S16b, also checked in the rig): it accepts single printable characters too, so the bridge allows only a strict subset of key tokens, from the desktop's key menu, each sending a control byte or an ESC-prefixed sequence (an `alt` letter is ESC then the letter). Refusals come as JSON on stderr.
- **Tailscale serve:**
  - Identity headers: the exact set, their absence for tagged nodes, and local forgery (hence the cookie).
  - On Linux it needs `tailscale set --operator=$USER`.
  - Serve config is global, so it can collide with other services.
- **iOS:**
  - Push needs iOS ≥16.4, a Home Screen install, HTTPS, and permission from a user gesture.
  - The Home Screen app's storage is separate from Safari's, so pairing happens first in Safari, and the Home Screen app pairs itself through the one-time transfer code (S5b); that step is still to be verified on a real iPhone.
  - Background sockets are killed, and push subscriptions can lapse.
- **The 1px link block:**
  - As the last child of `work`, it hasn't been tested for visual artifacts or for starting reliably.
  - It never starts in a layout opened with that column hidden.
  - A layout switch restarts it.
- **Performance:** `render()` frequency × the size of `terminals()` adds CPU and JSON cost inside the app. Dedupe has to be measured in the rig.
- **Mod networking:** the `net` surface (backpressure, large writes) is known only from the probe.
- **Detached launch:** double starts need `flock`, and `close()` gets only 250 ms.
- **Plugin freshness:**
  - Panorama is fresh only while its sidebar runs.
  - Peek can't show transcripts, because those need panorama's private binary.
  - Reusing plugin JS assumes it stays import-free; otherwise we pin vendored copies with a drift check.
- **Inbox verbs** put answer text on the command line for up to 5 s, where it's visible in the local process list. This comes from app-commands v1.
- **Terminal input** is on `hc send`'s command line for as long as the send runs (up to 15 s, while someone types at the desktop), visible in the local process list the same way. hc has no stdin form for send.
