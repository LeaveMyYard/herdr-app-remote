# bridge-api v1

The API between the PWA (and other clients) and the bridge. Source of truth: `packages/protocol/src/bridge-api.ts`. Fixtures: `fixtures/bridge-api/`.

## HTTP

`GET /api/v1/meta` returns `{api: 1, bridge: "<version>"}`.

`GET /healthz` returns `ok`. It is the only path exempt from the guards below, and it reveals nothing.

### Request guards

The bridge listens on `127.0.0.1` only and is reached through `tailscale serve`. Every request except `GET /healthz` must pass these checks, in this order:

| check | applies to | failure |
|---|---|---|
| Remote access isn't paused | everything | `503 paused` |
| `Host` is exactly the serve name (sent once) | everything | `403 forbidden` |
| `Tailscale-User-Login` is exactly the desktop owner's login (sent once) | everything | `403 forbidden` |
| `Origin` is exactly `https://<serve name>` | the WS upgrade and every non-GET request | `403 forbidden` |
| `X-Remote-Api: 1` is present | every non-GET request | `403 forbidden` |
| the client offers the subprotocol `herdr-remote.v1` (`Sec-WebSocket-Protocol`); the bridge echoes it | the WS upgrade | `403 forbidden` |
| the `__Host-hr-device` cookie names an approved device of the current owner login | the WS upgrade and every non-GET request except `POST /api/v1/pair` | `401 unpaired` |
| the device has `view` | the WS upgrade | `403 forbidden` |

- `Tailscale-User-Login` is a precondition, never the credential: any local process can forge it. The cookie is the credential.
- Tagged devices send no identity headers, so they are refused.
- Host, identity and Origin failures all answer the same `403 forbidden`, without saying which check failed.
- GETs have no side effects.
- **The WS upgrade uses a subprotocol, not a header.** A browser can't add headers to a WebSocket upgrade, so the client opens `new WebSocket(url, ["herdr-remote.v1"])`, and the bridge requires that subprotocol where PLAN §2 first said `X-Remote-Api: 1`. Like the header, a cross-site page can't make a simple request carry it, and the exact `Origin` and the `SameSite=Strict` cookie are required as well.

### Pairing

1. The desktop shows a QR code for `https://<serve>/pair#c=<code>`. The code is 128-bit (22 base64url characters), valid for 5 minutes and single use. Showing a new code invalidates the previous one.
2. The installed Home Screen app posts `POST /api/v1/pair` with JSON `{code, name?}` (`Content-Type: application/json`, at most 1 KiB).
   - `202 {device}`: the device is now `pending`. The response sets the device cookie: `__Host-hr-device=<256-bit token>; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict`. The cookie grants nothing until the desktop approves the device.
   - `403 {error: "bad_code"}`: the code is unknown, expired or already used. Every failure looks the same.
   - `429 {error: "rate_limited"}` after 10 failed codes within a minute; `429 {error: "too_many_pending"}` while 3 requests are already pending (the code isn't consumed). The rate limit is global, not per client. Requests sent at the same moment can exceed it slightly, which doesn't matter against a 128-bit code. A local process that forges the headers can use it to block pairing, but that process could already do worse.
   - `415 json_required`, `413 too_large`, `400 bad_json` for malformed bodies.
3. The desktop panel and a toast ask "Approve Phone 1?". The name the phone sends is only a hint: if it is taken, it gets a suffix ("Phone 1 (2)"). A request not approved within 10 minutes is dropped.
4. The app polls `GET /api/v1/me` until `device.state` is `approved`, then opens the WebSocket.

PLAN §2 says the phone gets its cookie "on approval". Setting it at pairing time instead is deliberate: the cookie is worthless until approval, and the bridge never has to hold a plaintext token while it waits for the desktop.

`GET /api/v1/me` returns `200 {device: {id, name, login, state, caps, terminal_input_until, created_at, approved_at, last_seen, live}}` for the cookie's device, or `401 {error: "unpaired"}`. `caps` maps each capability to whether it is in effect now.

Only the token's sha256 is stored, in `devices.json` (mode 0600, in a 0700 directory). Devices are revoked and renamed on the desktop only. A revoked device's sockets are closed at once, before the change is written to disk, so a failed write can't leave a revoked device streaming. A change of serve name or owner login closes every live socket.

### Capabilities

Checked by the bridge for every `act`:

| capability | default after approval | `act` kinds |
|---|---|---|
| `view` | on | none: needed for the WebSocket itself (all read topics) |
| `inbox.answer` | on | `inbox.draft`, `inbox.answer`, `inbox.dismiss`, `inbox.ack` |
| `navigate` | off | `agent.focus`, `tab.select`, `space.select`, `pane.focus` |
| `terminal.input` | off; turned on from the desktop only, can expire | `terminal.send` |
| `push` | off | `push.subscribe`, `push.unsubscribe` |

There is no generic `run`, no `exec` and no arbitrary `herdr-app do`. Any other kind is refused and logged.

### Audit

`activity.jsonl` (mode 0600, rotated at 1 MiB, 3 old files kept) records pairing, approvals, revocations, capability changes, pause, connections and every `act` with its outcome. Entries never hold free text or terminal input. They carry identifiers and lengths only, plus, for an answer, the option label the bridge resolved from its own inbox data. A label sent by the client is never logged. Examples: "Phone 1 sent 12 chars to t3", "Phone 1 answered Q119 (Option B)".

## WebSocket `/api/v1/ws`

One JSON object per text frame, each with a `type`.

### Client to server

| type | fields |
|---|---|
| `hello` | `api: 1`, `resume?: {epoch, seqs: {topic: seq}}` |
| `sub` | `topics: Topic[]` (at least one) |
| `act` | `id`, `kind`, `args` |
| `ping` | |

### Server to client

| type | fields | notes |
|---|---|---|
| `welcome` | `api`, `bridge`, `epoch` | `epoch` is random per bridge start. |
| `snap` | `topic`, `epoch`, `seq`, `data` | Full state of a topic. |
| `patch` | `topic`, `seq`, `ops` | RFC 6902 operations (`add remove replace move copy test`); paths are RFC 6901 JSON Pointers. |
| `stale` | `topic`, `reason` | Data may be out of date. Known reasons: `reconnecting`, `layout_without_remote`, `source_unavailable`. The field is open. |
| `res` | `id`, `ok`, `code?`, `unknown_effect?` | Result of an `act`. `code` is required when `ok` is false; `unknown_effect` is only valid when `ok` is false. |
| `event` | `topic`, `name`, `data` | Fire-and-forget notification. |
| `pong` | | Reply to `ping` (not in the plan's list; added so clients can detect dead sockets). |

### Topics

`host`, `plugins`, `panorama`, `inbox`, `usage` (polled every 15 s, only while subscribed), `chat:<t>` (any non-empty `<t>`), `setup`.

Payload schemas defined so far: `host` is `HostState` (see mod-link v1), `plugins` is `{panorama, inbox, usage, hc, host}`, each `{state, detail?}`, `usage` is `UsageTopic` (below) and `panorama` is described below. The other payloads are defined by their slices; until then `snap.data` is open.

### The `usage` topic

Source: `usagebar collect --format v1 [--all] --panes <JSON>` (agent-usage `docs/collect-json-v1.md`). Schema: `UsageTopic` in `packages/protocol/src/bridge-api.ts`; fixtures in `fixtures/bridge-api/usage/`.

- The bridge runs it only while at least one client is subscribed: at once for the first subscriber, then every 15 s, with a 10 s timeout, never two at a time. When the last client leaves, it stops.
- `--panes` is built from the `host` topic's agents (`paneId` is the terminal id, `agent` the harness, `label` the agent name; `antigravity` and `cursor-agent` become usagebar's `agy` and `cursor`). Without a host state it is `[]`.
- With an app home configured, collect runs like agent-usage's own panel: `/usr/bin/env HERDR_PLUGIN_CONFIG_DIR=<configDir> <binary> collect ...`, where `binary` and `configDir` come from `<app home>/mods/agent-usage/local.json` (read-only; defaults `~/.local/bin/usagebar` and `~/.config/agent-usage`), so the phone shows the same accounts as the desktop panel.
- `--panes` carries no `cwd` (the host state has none; the Grok provider uses it): a follow-up needs the mod link to send it.
- The bridge never runs `usagebar notify`: a second consumer of toasts would split them with the desktop mod (PLAN section 7).
- `UsageTopic = {filter: "open-panes" | "all", report: UsageReport | null, updatedAtMs: number | null, error?}`. `report` keeps what the screen draws: `watchDirs`, `apiUsage`, per-pane shares and `resetsAt` are dropped, unknown fields are ignored, and `identity`, `source` and `home` under the bridge user's home are abbreviated with `~`.
- `error` is one of `unavailable` (not installed or cannot run), `timeout`, `failed` (non-zero exit), `bad_output` (invalid JSON or shape) and `unsupported` (another `version`). The last good `report` stays while `error` is set; no CLI output is forwarded.
- `act`: `usage.refresh {}` collects now and answers when it is done; `usage.set_filter {filter}` switches between Open panes and All (shared by every client), clears `report` at once and collects again. Both acts collect even with no subscriber (they are explicit requests; the polling is what is subscription-gated). A failed collect answers `ok: false` with the error as `code`. Any other `act` kind is not the usage topic's.
- Plugin states: `plugins.usage` decides what the Usage tab shows. `missing`, `too_old` and `broken` show the Missing screen; `ready`, `stale` and `not_running` show the panel.

### Resume and consistency

- `seq` is per topic within an epoch. A `snap` sets the topic's `seq`; each `patch` for that topic carries previous + 1. `hello.resume.seqs` maps each topic to the last `seq` the client applied. `patch` carries no `epoch`: a bridge restart is detected through `welcome.epoch`, after which the client resubscribes and gets fresh `snap`s. A `seq` gap on a topic means the client re-subscribes to that topic only and receives a fresh `snap`.
- `snap.data` is validated against the topic payload schema where one is defined (`host`, `plugins`, `usage`, `panorama`).
- Each bridge start gets a random epoch. A client that resumes with an unknown epoch, or whose seq has a gap, gets a fresh `snap`.
- iOS kills background sockets, so the PWA reconnects on `visibilitychange` and `online`.
- There is no optimistic UI: the UI changes only on `snap`, `patch` or `res`.

- A `stale` is cleared by the next `snap` of that topic (the bridge never patches across a stale period). A subscriber to a topic with no state yet receives no `snap` until the first one exists (for `host`, only `stale` `reconnecting` before the first link hello).
- `sub` always answers with the topic's current state, so re-subscribing is the recovery for a seq gap. `hello.resume` is honoured on the first `sub` of each topic: already current gets nothing, a gap within the bridge's last 64 patches is replayed, anything else gets a `snap`.
- A client that sends anything before `hello`, a second `hello`, invalid JSON, a binary frame or a frame over 64 KiB is closed.
- A connection may hold at most 64 topic subscriptions. A `sub` that would exceed this closes it with code 1008 ("too many topics").
- Frames from one connection are handled strictly in order. A slow `act` delays that connection's later `ping` and `sub` until its `res` is sent.

### Action results and close codes

`res` codes from the security layer:

| code | meaning |
|---|---|
| `unsupported_action` | not on the allowlist, or no slice handles it yet |
| `forbidden` | the device lacks the capability (an expired `terminal.input` counts as off) |
| `unpaired` | the device was revoked, or isn't approved; the socket is closed too |
| `paused` | remote access is paused |
| `internal_error` | the handler threw; always with `unknown_effect: true` |

The device is re-checked before every `act`, so a revoke or pause refuses the next one. An `act` that is already running when it lands still completes.

WebSocket close codes: `4001` the device was revoked (or the serve name or owner login changed), `4002` remote access was paused, `4003` `view` was turned off. A client that gets one of these should not reconnect on its own. From the moment the bridge sends the close, that connection's `act`s are refused. The transport is terminated 1 s later, whether or not the peer answered the close.

### Plugin states

`ready`, `missing`, `too_old`, `broken`, `stale`, `not_running`.

| plugin | detected by |
|---|---|
| panorama | install receipt, `contract.js` hash, feed `v == 2` |
| inbox | `app --help` first line is `herdr-inbox app v1` |
| usage | `usagebar collect --format v1` |
| hc | `hc --version` |
| host | the link, or `herdr-app status` |

Mapping to states (`packages/bridge/src/plugins/`):

- panorama: no install receipt is `missing`. An unreadable receipt, a `contract.js` that fails its receipt hash or does not load, or a feed that fails `contract.js` is `broken`. No feed file is `not_running`. A feed older than 15 s is `stale`. Feed `v < 2` is `too_old`, `v > 2` is `broken`.
- inbox: not installed is `missing`; a first line other than `herdr-inbox app v1` (or no `app` command) is `too_old`; a newer protocol or a failed or timed-out probe is `broken`.
- usage: runs `usagebar collect --format v1 --quotas-only --panes []`. Not installed is `missing`; `--format` rejected or no `version` field is `too_old`; another version, bad JSON or a failure is `broken`.
- hc: below the minimum (`MIN_HC_VERSION`) is `too_old`; no version in the output or a failure is `broken`.
- host: derived from the `host` topic (`ready`, `stale` on `reconnecting`, `not_running` on `layout_without_remote` or before the first link hello, `broken` on `source_unavailable`).

Probes run every 30 s with a 10 s timeout each (SIGTERM, then SIGKILL after 0.5 s; the probe is reported `broken` at once); `host` is re-derived every second. A probe that throws reports `broken`. `detail` is a short fixed sentence; it never carries CLI output or a path.

Plugin JS the bridge loads (panorama `contract.js`, inbox `feed.js` and `commands.js`) is read once, compared with the plugin's own `install.json` hash, and imported from those same bytes. A file with any import (found by a lexer) is refused, so inbox `model/*` (which imports its siblings) is not loadable this way: a later slice has to vendor it with a drift check or load a pinned graph.

### `panorama` topic

Source: `packages/protocol/src/bridge-api.ts` (`PanoramaTopic`), built by `packages/bridge/src/panorama/`. Fixtures: `fixtures/bridge-api/panorama/`.

`{mode, stale, aged, error, collected_at, roots[]}`:

- `mode`: `rich` needs a lease owner (`host.shared["panorama.feed.owner"]` not null) and a feed (a retained one counts); otherwise `basic`, with no roots, and the phone shows the stock Agents list.
- The feed is `<appHome>/data/panorama/feed.json`, read at most once a second and validated by panorama's own `contract.js` (`readResult`). A missing, oversized, unreadable or invalid feed never replaces the last good one: `stale` is true, `error` is one of `feed missing`, `feed unreadable`, `feed too large`, or `feed invalid`, and the retained roots stay. If `contract.js` stops verifying (hash or load), nothing from the feed is trusted: the topic is `basic` with `error` `contract unavailable`, and the retained roots are not shown. A feed that never read is `basic` with the error. A feed with no roots and no error is a real empty swarm.
- `aged`: the feed is older than 15 s (or unstamped, or from the future; `contract.js` `aged`). Terminal numbers prove nothing then, so no join is applied: every root has `agent_id`, `space_id` null and `live` false. A root whose address matches a live host row is `shadowed`, so the Agents list doesn't show it twice. A stale feed that is not aged keeps its joins.
- A root joins a host agent only by exact address: `host == "herdr-core"`, a non-null `terminal`, equal to the host agent's `terminal_id` (the link mod mirrors `agents().address` there). Never by cwd, title, pane id or session id; a remote address (`vps/t7`) never matches a local one. `title` is the host agent's name when joined, else the feed title, else `tab_label`, else `pane_id`.
- `agents[]` of a root are the feed's agents, parents before children, with `parent` normalised (dangling, self and cyclic parents are `null`). Statuses are the feed's codes (`q run rev wait blk fail done cxl inf lost bg stale`, plus `idle` for a root and `unknown` for a code this version doesn't know); root `working` is `run` and `blocked` is `blk`. Long display text is cut at 1000 characters. Transcript paths are never sent.
- `inbox` is the root's complete open-question id list; the phone derives `?N` from it (a union, never root plus agent lengths).

The phone shows Swarm for a space from the roots joined to it; while `aged` nothing is joined, so it shows every retained root with a notice rather than an empty swarm. Peek shows feed fields only. A transcript needs a source the feed doesn't provide (it carries only a local path), so the Transcript view appears only when a later slice supplies one.

### Action results

A non-zero exit outside the contract, or bad stdout, is reported as `res {ok: false, unknown_effect: true}`. The PWA says so, refreshes, and never retries by itself.

### Layout switch

1. The link closes and the `host` topic goes `stale` with reason `reconnecting`. The last state stays on screen.
2. A new `hello` sends a fresh `snap`.
3. If no `hello` arrives within 5 s and the shown layout has no link block, the reason becomes `layout_without_remote` and the phone shows "Switch to a layout with Remote".
