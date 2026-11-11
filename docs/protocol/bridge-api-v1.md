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

Payload schemas defined in S1: `host` is `HostState` (see mod-link v1) and `plugins` is `{panorama, inbox, usage, hc, host}`, each `{state, detail?}`. The other payloads are defined by their slices; until then `snap.data` is open.

### Resume and consistency

- `seq` is per topic within an epoch. A `snap` sets the topic's `seq`; each `patch` for that topic carries previous + 1. `hello.resume.seqs` maps each topic to the last `seq` the client applied. `patch` carries no `epoch`: a bridge restart is detected through `welcome.epoch`, after which the client resubscribes and gets fresh `snap`s. A `seq` gap on a topic means the client re-subscribes to that topic only and receives a fresh `snap`.
- `snap.data` is validated against the topic payload schema where one is defined (`host`, `plugins`).
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

WebSocket close codes: `4001` the device was revoked (or the serve name or owner login changed), `4002` remote access was paused, `4003` `view` was turned off. A client that gets one of these should not reconnect on its own.

### Plugin states

`ready`, `missing`, `too_old`, `broken`, `stale`, `not_running`.

| plugin | detected by |
|---|---|
| panorama | install receipt, `contract.js` hash, feed `v == 2` |
| inbox | `app --help` first line is `herdr-inbox app v1` |
| usage | `usagebar collect --format v1` |
| hc | `hc --version` |
| host | the link, or `herdr-app status` |

### Action results

A non-zero exit outside the contract, or bad stdout, is reported as `res {ok: false, unknown_effect: true}`. The PWA says so, refreshes, and never retries by itself.

### Layout switch

1. The link closes and the `host` topic goes `stale` with reason `reconnecting`. The last state stays on screen.
2. A new `hello` sends a fresh `snap`.
3. If no `hello` arrives within 5 s and the shown layout has no link block, the reason becomes `layout_without_remote` and the phone shows "Switch to a layout with Remote".
