# bridge-api v1

The API between the PWA (and other clients) and the bridge. Source of truth: `packages/protocol/src/bridge-api.ts`. Fixtures: `fixtures/bridge-api/`.

## HTTP

`GET /api/v1/meta` returns `{api: 1, bridge: "<version>", host_name?: "<name>"}`. `host_name` is the computer's name as the phone's copy says it ("Connecting to desk-1…"): the first label of the serve identity's tailnet name (`desk-1.example-tailnet.ts.net:8443` is `desk-1`), else the first label of the bridge machine's hostname. The phone asks once per connect and falls back to the first label of the page's own host name.

`GET /healthz` returns `ok`. It is the only path exempt from the guards below, and it reveals nothing.

### Listener and Funnel

- The API listens on `127.0.0.1:47391` only (`DEFAULT_API_PORT`, fixed so that `tailscale serve --https=8443` can forward to it). The bridge never binds another address.
- **Funnel refusal.** The bridge reads `tailscale serve status --json` (read-only) at start and every 30 s. While Funnel is on for the serve port `:8443`, or for any `host:port` whose web or TCP handler forwards to the API port (foreground sessions included), every request, `/healthz` included, answers `503 funnel`, and live sockets are closed with `4004`. Until the first check has run, requests answer `503 starting`. From the close on, that socket's `act`s answer `funnel`.
  - Tailscale not installed counts as off: nothing can be funneled. A check that fails, times out or prints something unreadable proves nothing: before any verdict the bridge refuses (`503 funnel_unknown`, retried every 5 s); after one it keeps it, so once Funnel was seen on, only a clean "off" serves again. Funnel traffic carries no `Tailscale-User-Login`, so the identity guard below would refuse it anyway; the Funnel check is the outer wall.

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

<!-- PENDING-MERGE S5b (PR #24): this section describes pairing as merged on main. S5b adds /pair in Safari, the Home Screen transfer code and POST /api/v1/pair/transfer; update when it lands. -->
### Pairing

1. The desktop shows a QR code for `https://<serve>/pair#c=<code>`. The code is 128-bit (22 base64url characters), valid for 5 minutes and single use. Showing a new code invalidates the previous one.
2. The installed Home Screen app posts `POST /api/v1/pair` with JSON `{code, name?}` (`name` is ignored: the bridge names the device) (`Content-Type: application/json`, at most 1 KiB).
   - `202 {device}`: the device is now `pending`. The response sets the device cookie: `__Host-hr-device=<256-bit token>; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict`. The cookie grants nothing until the desktop approves the device.
   - `403 {error: "bad_code"}`: the code is unknown, expired or already used. Every failure looks the same.
   - `429 {error: "rate_limited"}` after 10 failed codes within a minute; `429 {error: "too_many_pending"}` while 3 requests are already pending (the code isn't consumed). The rate limit is global, not per client. Requests sent at the same moment can exceed it slightly, which doesn't matter against a 128-bit code. A local process that forges the headers can use it to block pairing, but that process could already do worse.
   - `415 json_required`, `413 too_large`, `400 bad_json` for malformed bodies.
3. The desktop panel and a toast ask "Approve a new phone?"; the toast has no device text. A `name` in the pair request is ignored: the bridge names every pending device itself ("Phone 1", "Phone 2", ...), and the desktop may rename it after approval. A request not approved within 10 minutes is dropped.
4. The app polls `GET /api/v1/me` until `device.state` is `approved`, then opens the WebSocket.

PLAN §2 says the phone gets its cookie "on approval". Setting it at pairing time instead is deliberate: the cookie is worthless until approval, and the bridge never has to hold a plaintext token while it waits for the desktop.

`GET /api/v1/me` returns `200 {device: {id, name, login, state, caps, terminal_input_until, created_at, approved_at, last_seen, live}}` for the cookie's device, or `401 {error: "unpaired"}`. `caps` maps each capability to whether it is in effect now.

Only the token's sha256 is stored, in `devices.json` (mode 0600, in a 0700 directory). Devices are revoked and renamed on the desktop only. A revoked device's sockets are closed at once, before the change is written to disk, so a failed write can't leave a revoked device streaming. A change of serve name or owner login closes every live socket.

### Capabilities

Checked by the bridge for every `act`:

| capability | default after approval | `act` kinds |
|---|---|---|
| `view` | on | needed for the WebSocket itself (all read topics), plus `usage.refresh` and `usage.set_filter`, which only re-run the collect the subscription polls |
| `inbox.answer` | on | `inbox.draft`, `inbox.answer`, `inbox.dismiss`, `inbox.ack`, `inbox.retry`, `inbox.stop_showing` |
| `navigate` | off | `agent.focus`, `tab.select`, `space.select`, `pane.focus` |
| `terminal.input` | off; turned on from the desktop only, can expire | `terminal.send` |
| `push` | off | `push.subscribe`, `push.unsubscribe` |

There is no generic `run`, no `exec` and no arbitrary `herdr-app do`. Any other kind is refused and logged.

`terminal.input` is turned on from the desktop's Remote panel, with no limit or for a chosen time. When the time is up the bridge turns it off by itself: in `devices.json`, in Activity ("Phone 1: terminal.input expired") and in the panel. A grant that ran out while the bridge was down is turned off when it starts. Every check also compares the time, so an expired grant is refused even before that happens.

### Rate limits

Per approved device, on top of the pairing limit above:

| what | limit | past it |
|---|---|---|
| WebSocket upgrades | 20 per minute | `429 rate_limited` on the upgrade |
| `act`s of any kind and outcome | 30 per 10 s | `res` `rate_limited` |
| `terminal.send` (counted once the capability allows it) | 6 per 10 s | `res` `rate_limited` |

A refusal for a limit is written to Activity once per filled window, not once per attempt, so a looping client can't flood the log. The windows slide: the next attempt is allowed once the oldest counted one is older than the window.

### Audit

`activity.jsonl` (mode 0600, rotated at 1 MiB, 3 old files kept) records pairing, approvals, revocations, capability changes, pause, connections and every `act` with its outcome. Entries never hold free text or terminal input. They carry identifiers and lengths only, plus, for an answer, the option label the bridge resolved from its own inbox data. A label sent by the client is never logged. Examples: "Phone 1 sent 12 chars to t3", "Phone 1 answered Q119 (Option B)".

A write to `activity.jsonl` that fails (a full disk, a broken file) is flagged: the desktop panel's Status shows "Activity log can't be written" until a write goes through again, and the bridge logs `audit_health`. The action whose line was lost has already been decided and still completes. `terminal.send` alone is refused (`audit_unavailable`) while the log is failing, because its audit line is its whole safeguard; the refusal's own line is the probe that clears the flag.

### Web Push (S17)

Push is off per device until the desktop turns on the `push` capability. Subscribing does not depend on how the device was paired: a subscription belongs to the device whose socket sent it.

- **Keys.** The bridge makes one VAPID key pair (P-256) on first start and keeps it in `vapid.json` (mode 0600). A damaged file is an error, never replaced, since a new key would orphan every subscription; its contents are never quoted in the error. A damaged `push.json` is instead moved aside to `push.json.damaged` (0600) and the bridge starts with no subscriptions (Activity: "Push subscriptions were unreadable…"); phones turn notifications on again.
- **`GET /api/v1/push`** (same guards as any GET, plus an approved device's cookie, else `401 unpaired`) returns `{key, allowed, subscribed}`: the VAPID public key (base64url, the `applicationServerKey`), whether the device may get pushes now, and whether the bridge holds its subscription. Read-only.
- **`act push.subscribe {endpoint, keys: {p256dh, auth}}`** (the browser's `PushSubscription.toJSON()`, nothing else) stores one subscription per device in `push.json` (0600), replacing the device's earlier one and any other device's with the same endpoint. Refusals: `bad_args`, `bad_endpoint` (only `https:` on port 443 of `web.push.apple.com`, `*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.services.mozilla.com` or `*.notify.windows.com`, with no credentials, at most 1024 characters: a subscription must not turn the bridge into a client for any other URL), `bad_keys` (`p256dh` is not a P-256 point, or `auth` is not 16 bytes). **`act push.unsubscribe {}`** forgets it. Both need `push`, and both are audited ("Phone 1 turned push on").
- **The PWA** shows the notifications row only in the Home Screen app, and asks for permission only from a tap, as the first thing the tap does (iOS requires the user gesture).
- **Triggers.** The bridge looks at its own topics once a second:
  - an inbox `group` or `alert` row marked `new` (app-feed-v1's toast marks, so nothing open when the bridge started is new);
  - a panorama root whose status becomes `blk`, in a fresh rich feed. The first such reading after start, or after the feed was aged, stale or basic, only seeds.
  - The push service's own first look also only seeds. Nothing that was there before a bridge restart is announced.
  - A root is announced as blocked at most once per 5 minutes. Several new things in one look become one notification ("and 2 more"); each device gets at most 20 per 10 minutes.
- **Payload** (`PushPayload`, encrypted with RFC 8291 `aes128gcm`, signed with a VAPID JWT whose `sub` is the project URL): `{v: 1, kind, title, body, tag, url}`. `title` is "Agent 1: Question Title 123" (the question group's title, else its first question's header, never the question text; PLAN §7.3), "Agent 1: Alert Title 456" (never the alert message) or "Agent 1 is blocked" (the name only through the root's verified host agent, else "An agent": a root's own title can be an AI summary of the session). `body` is a fixed word ("New question", "Alert", "Needs you", "and 2 more"). `url` is a `#/` route of the PWA (a question opens `#/inbox/q/<key>/<first question without a draft>`); the service worker accepts nothing else. Headers: `TTL: 14400`, `Urgency: high`.
- **At start** the bridge also drops subscriptions of devices revoked, or with `push` turned off, while it was down.
- **Who gets it.** Every subscription whose device is approved, current, not paused and has `view` and `push` now, while the bridge is serving (no Funnel). Revoking the device or turning `push` off deletes its subscription at once; pause or a login change only holds sends.
- **Answers.** 2xx is sent. `404` and `410` drop that subscription (only if it still has that endpoint) and log "Phone 1: push subscription expired". Anything else, or no answer within 10 s, logs a failure and keeps the subscription; nothing is retried. Redirects are not followed.
- **Audit** entries carry identifiers only, never titles, names of agents or endpoints: "Push sent to Phone 1: group 123", "Push sent to Phone 1: A456", "Push sent to Phone 1: an agent", "Push to Phone 1 failed: group 123" (code `http_500` or `no_answer`), "Push to Phone 1 skipped: …" (`rate_limited`).

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
| `stale` | `topic`, `reason` | Data may be out of date. Known reasons: `reconnecting`, `layout_without_remote`, `source_unavailable`, and for `chat:<t>` `terminal_not_found`, `bad_terminal`, `too_many_chats`. The field is open. |
| `res` | `id`, `ok`, `code?`, `unknown_effect?`, `message?`, `closed?` | Result of an `act`. `code` is required when `ok` is false; `unknown_effect` is only valid when `ok` is false. `message` is plain text the PWA may show, in the plugin's own words (never answer text). `closed` (inbox acts) says the row is closed now, and why. |
| `event` | `topic`, `name`, `data` | Fire-and-forget notification. |
| `pong` | | Reply to `ping` (not in the plan's list; added so clients can detect dead sockets). |

### Topics

`host`, `plugins`, `panorama`, `inbox`, `usage` (polled every 15 s, only while subscribed), `chat:<t>` (any non-empty `<t>`), `setup`.

Payload schemas defined so far: `host` is `HostState` (see mod-link v1), `plugins` is `{panorama, inbox, usage, hc, host}`, each `{state, detail?}`, `usage` is `UsageTopic` (below), `panorama` and `setup` are described below. The other payloads are defined by their slices; until then `snap.data` is open.

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

### `setup` topic (Tailscale setup and serve control)

Source: `packages/bridge/src/tailscale/` (`Setup`). Schema: `SetupTopic` in `packages/protocol/src/bridge-api.ts`; fixtures in `fixtures/bridge-api/setup/`. The desktop panel shows it (DesktopSetup board); phones may subscribe, read-only.

`{step, steps[5], serving, port, url, login, can_start, can_stop, notice, busy, checked_at}`. Each step is `{id, state, title, detail, problem?}` with `state` `done`, `current` (the first not done) or `todo`; only the current step carries a `problem` `{code, message, fix?, url?}`. `message` is a fixed sentence, never CLI output. `fix` is a command for the person to run (the bridge never runs it); `url` is always a `https://login.tailscale.com/` page. `step` is 6 when all five are done. `notice` is a problem from the last Start or Stop that the steps can't show because step 4 reads done: Stop failing while the handler is still ours (e.g. `operator`), or Start that served but could not record the handler as ours (`failed`, with `fix: "tailscale serve --https=8443 off"`: herdr will never remove an unrecorded handler). It is cleared by the next Start or Stop, once the port no longer holds the handler, or (for a Stop that could not read the config) by the next clean read. It is held in memory only: after a bridge restart an unrecorded handler reads `identical` (used, never removed by herdr, no Stop offered) with no notice, which fails safe. `can_start` and `can_stop` do not drop while `busy`: a Start or Stop queues behind a running check and reads everything again before it changes anything.

| step | done when | problems |
|---|---|---|
| 1 `installed` | `tailscale version` is at least 1.52 (serve v2) | `not_installed`, `too_old`, `unknown` |
| 2 `signed_in` | `tailscale status --json`: `BackendState` `Running`, the node is not tagged, the owner (`User[Self.UserID].LoginName`) is known | `daemon_down`, `needs_login`, `stopped`, `tagged`, `unknown` |
| 3 `https` | MagicDNS is on and `CertDomains` holds this node's name | `magicdns_off`, `https_off` (both link the admin DNS page) |
| 4 `serving` | the serve port (`:8443`) holds exactly our handler | `port_taken`, `funnel_on`, `operator`, `serve_disabled`, `not_ours`, `failed`, `unknown` |
| 5 `phone` | a device is approved | `no_device` |

`serving` says how the port is configured: `ours` (our handler, created by this bridge), `identical` (exactly our handler, created by someone else: used, never removed), `off`, `foreign`, `funnel` or `unknown`. "Exactly our handler" means `TCP[port] == {HTTPS: true}`, one web entry `<this node's DNS name>:<port>` whose only handler is `/` with `Proxy: http://127.0.0.1:47391`, no Funnel and no foreground session on the port.

Checks only read: `tailscale version`, `status --json` and `serve status --json`, every 5 s for 10 minutes after the last explicit check, start or stop while steps 1 to 4 are not all done, every 30 s otherwise (step 5 waits on an approval, which updates it at once). A check that fails or prints something unreadable proves nothing and keeps the last identity.

**Start serving** (`setup.start()`):
- refuses unless steps 1 to 3 are done and the port is `off`: any other handler on the port, foreground sessions included, is `port_taken`; Funnel on it is `funnel_on`. Nothing is run then;
- runs `tailscale serve --bg --https=8443 http://127.0.0.1:47391` (20 s limit: when serve is not enabled for the tailnet, the CLI prints an enable link and waits; it is cut off, and the link is shown as `serve_disabled`);
- reads the config back: only an exact handler, and only when the command succeeded or was cut off by the time limit, is recorded as ours, in `data/herdr-app-remote/serve.json` (0600). Anything else is `failed` and left alone.

**Not atomic.** The CLI has no compare-and-set: a handler mounted on the port between the bridge's read and its command (a process spawn apart) would be replaced by Start, or removed by Stop. This window is accepted for v1; nothing else can make the bridge change a config it did not create.

**Stop serving** (`setup.stop()`) runs `tailscale serve --https=8443 off` only while the port is `ours`: our record exists and the port still reads exactly our handler. The record is dropped as soon as a check finds the port empty, different or funneled, so a handler that later reads exact again is someone else's and is never removed. Handlers on other ports are never touched.

**The operator error (Linux).** A user who is not tailscale's operator may not change serve config. The CLI's "access denied" output becomes `operator` with `fix: "sudo tailscale set --operator=$USER"`. The bridge never runs it.

**Funnel** is never used: no command the bridge runs enables it, start refuses while it is on, and the API refuses while it is on (see "Listener and Funnel").

**Serve identity.** While the port is `ours` or `identical` on a signed-in, untagged node, the bridge's serve identity (`Security.setServe`) is `{host: "<DNS name>:8443", login: <owner login>}`: the `Host` every request must carry and the `Tailscale-User-Login` it must match. It changes only when the value changes; a change drops every live socket (`4001`) and the current pairing code, and while it is unset `/api/v1/me` answers 403, which the PWA treats as final. So it is cleared only on proof that access is gone for good: the port is empty or someone else's, or the node is tagged; an owner change replaces it. States in which serve can't deliver a request anyway keep it: tailscaled down or stopped, signed out, MagicDNS or HTTPS off, a read that can't tell, and Funnel (Setup seeing Funnel makes the bridge re-read its Funnel verdict at once, so phones get `503 funnel` and close `4004`, and serve again once it is off). A bridge started with an explicit `serve` (tests, rigs) runs no setup, and `App.setServe` throws while setup runs.

The desktop panel reaches `check`, `start` and `stop` through the mod link: the argument-free `setup.check`, `setup.start` and `setup.stop` panel acts (mod-link v1, S14b). Every finished Start and Stop is written to Activity from its outcome code only. `App.stop` waits for a Start or Stop in flight.

### `chat:<t>` (read-only)

`<t>` is a terminal id (`t3`, or `vps/t7` on another machine): it must match `TERMINAL_ID` in the protocol package (no leading dash, no spaces, at most 64 characters per part), or the topic goes `stale` with `bad_terminal` and `hc` is never run.

Payload: `{terminal, lines, truncated?}`. `lines` is an array of lines, each an array of spans `{t, fg?, bg?, b?, d?, i?, u?, r?}`. `t` is printable text only; the bridge has already turned ANSI into these fields and dropped every other escape sequence and control character. `fg` and `bg` are a palette index 0 to 15 (the theme's ANSI colours) or `#rrggbb`. `r` is reverse video. A client renders `t` as text, never as HTML. At most 500 lines are kept (`truncated` says older ones were dropped).

Source: while at least one client is subscribed, the bridge runs `hc read <t> --lines 200` once a second (never overlapping, backing off to 5 s while it fails) and `hc ls --json` on the first read and every tenth one after, to notice a terminal that has closed (`stale` `terminal_not_found`). Nothing runs with no subscriber, and at most 6 chats are read at once (`too_many_chats`). `hc events` is not used: it has not been tested against a live core (PLAN section 8). The `hc ls --json` shape is likewise unverified, so its output is read tolerantly and an unrecognised shape is ignored. The topic needs the `view` capability and sends nothing to the terminal; input is `terminal.send` (S16, below).

<!-- PENDING-MERGE S16b (PR #22): special keys (hc keys, capability terminal.keys, the keys topic) are not on main yet; the key bar note below is true only until it lands. -->
### `terminal.send` (S16)

`act terminal.send {terminal, text}` types into a terminal. It needs `terminal.input`. The bridge runs exactly `hc send --json -- <terminal> <text>`, with no shell: hc pastes the text and presses Enter. The `--` matters: without it a text such as `--force` would be read as hc's own flag. `--force` itself is never passed, so hc still refuses to type into a program that is blocked on a dialog.

- `terminal` must match `TERMINAL_ID`. `text` is at most 4000 characters and may hold newlines and tabs but no other control character (ESC above all), no DEL and no C1 control (`TerminalSendArgs` in the protocol package); `\r` is refused, so a client sends `\n`. An empty `text` presses Enter alone. Anything else is `bad_args`, and hc doesn't run.
- That is all `hc send` can do: checked in the rig against hc 0.1.19, it has no special keys (Esc, Tab, Ctrl-C, arrows). Those belong to a separate `hc keys`, which is not exposed. The PWA's key bar therefore has only ⏎ (an empty send) and `/` (which types a slash into the composer and sends nothing).
- One send runs at a time per device; a second while one runs is `busy`. A send that times out (15 s; hc holds a send until nobody has typed at the desktop for about 3 s) holds the device for one more second while hc is killed.
- A send still held by hc when the device loses the right to type (revoked, paused, `terminal.input` or `view` turned off, expired, serve identity changed, Funnel turned on) is killed at once and answers `cancelled` with `unknown_effect`: hc may already have handed the text to its core, which is not verified. This is the exception to "an act that is already running still completes".
- Results: `ok` when hc exits 0 with a JSON object. hc prints a refusal as `{"error":{"kind":…}}` on stderr; the kinds that mean nothing was typed map to `terminal_not_found` (`not_found`, `machine_unknown`, `needs_target`), `terminal_finished` (`finished`), `terminal_blocked` (`blocked`: the program is on a dialog) and `send_refused` (`usage`, `invalid_params`, `status_mismatch`). The send errors come from `hc schema` (hc 0.1.19); `not_found`, `finished` and `usage` were also seen in the rig, `blocked` was not (the rig has no program on a dialog). `unavailable` and `config` stay unknown effects: the schema doesn't say whether anything was typed first. `hc_missing` when hc isn't installed. Anything else (another exit, another kind, bad output, `timeout`) may have typed: `send_failed` or `timeout` with `unknown_effect`. The PWA says so and re-reads the chat; it never sends again by itself.
- Activity records the length only: "Phone 1 sent 12 chars to t3". The text is never logged, echoed in a `res`, or kept.
- The PWA asks before the first send to each terminal while it is open ("Type this into Agent 1's terminal?"); the bridge doesn't depend on that.

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

### The PWA's client (`packages/pwa/src/bridge/client.ts`)

- Before each connect it asks `GET /api/v1/me`, because a browser can't see why an upgrade was refused: `401` shows "not paired" and retries every 10 s, `403` stops ("no longer accepts this phone"), `503` retries every 10 s, a network error retries with backoff.
- It sends `hello` (with `resume` once it knows an epoch), then one `sub` for every topic the screens want. `usage` is asked for only once the Usage tab has been opened (it polls the desktop's CLI while subscribed), and `chat:<terminal>` only while that chat is open. There is no `unsub`, so 10 s after the last topic is given up (and with no `act` in flight) the client replaces its socket quietly: the resume `hello` subscribes only what is still wanted, and the bridge stops reading the closed chat.
- A seq gap asks once for a fresh `snap`; later patches of that topic are dropped until it arrives. Any frame on a greeted socket shows the client as online again, whatever the browser's `offline` event said.
- Reconnects use backoff from 0.5 s, doubling, to 10 s. `visibilitychange` (to visible) and `online` reconnect at once; with a socket still open they send a `ping` and reconnect if no frame arrives within 5 s. A socket silent for 45 s is replaced.
- An `act` in flight when the socket goes resolves `connection_lost` with `unknown_effect`, and is never resent. An `act` while not connected resolves `offline` and sends nothing.
- `navigate` kinds (`agent.focus`, `tab.select`, `space.select`, `pane.focus`) are sent to the link copy as an allowlisted `run`; its outcome maps to `res` (`no_link`, `timeout`, `link_lost`, ... with `unknown_effect` where the command may have run).

### Action results and close codes

`res` codes from the security layer:

| code | meaning |
|---|---|
| `unsupported_action` | not on the allowlist, or no slice handles it yet |
| `forbidden` | the device lacks the capability (an expired `terminal.input` counts as off) |
| `unpaired` | the device was revoked, or isn't approved; the socket is closed too |
| `paused` | remote access is paused |
| `internal_error` | the handler threw; always with `unknown_effect: true` |
| `rate_limited` | the device is over a rate limit (see Rate limits) |
| `audit_unavailable` | `terminal.send` while Activity can't be written |

The device is re-checked before every `act`, so a revoke or pause refuses the next one. An `act` that is already running when it lands still completes.

WebSocket close codes: `4001` the device was revoked (or the serve name or owner login changed), `4002` remote access was paused, `4003` `view` was turned off. A client that gets one of these should not reconnect on its own. `4004`: the bridge stopped serving because Funnel is on; the client may retry slowly (the PWA retries every 10 s). From the moment the bridge sends the close, that connection's `act`s are refused. The transport is terminated 1 s later, whether or not the peer answered the close.

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

Plugin JS the bridge loads (panorama `contract.js`, inbox `feed.js` and `commands.js`) is read once, compared with the plugin's own `install.json` hash, and imported from those same bytes. A file with any import (found by a lexer) is refused, so inbox `model/*` (which imports its siblings) is not loadable this way. The bridge does not need it: `model/*` is the popup's state machine over the database snapshot, and everything the phone reads is in the feed. See the inbox topic below.

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

## Inbox topic (`inbox`)

`packages/bridge/src/inbox/`, schema `bridgeApi.InboxTopic`, fixtures `fixtures/bridge-api/inbox/`. It reads herdr-inbox's feed (herdr-inbox `docs/protocol/app-feed-v1.md`) and follows every reader rule in it.

- **Plugin code.** `feed.js`, `commands.js` and `words.js` are import-free, so they load hash-pinned like panorama's `contract.js`. `parseFeed`, `isStale`, `incompleteness`, `leftOut`, `showArgs`, `readResult` and the delivery and severity wording are the plugin's own. `model/*` is not loaded or vendored: the popup model works on the database snapshot and the phone needs nothing from it. Read-only, there is also nothing to drift.
- **Launcher.** Every command is `sh <root>/scripts/launch cli ...`, with the root from the install record (it must still hold `herdr-plugin.toml` and `scripts/launch`), and only when the record says `plugin_moves: false` (the operator's own checkout). A moving install may leave an old copy on disk, and finding the current one needs `herdr plugin list` or Claude Code's `installed_plugins.json`, which are not consulted yet: it reads as `missing`.
- **Availability.** `herdr-inbox app --help` must print `herdr-inbox app v1` (`plugin: ready`). Any other state publishes `state: unavailable` and no rows.
- **Writer.** While the feed is stale (older than 15 s, unstamped, from the future, or the newest read failed) and the probe passed, the bridge runs `app-feed --ensure --app-home <home>` at most once per 5 s. Exit 1 is not an error: the feed's age is what the phone shows.
- **Last good feed.** A missing, unreadable, unsupported or `ok: false` feed keeps the last good one, `stale: true` with the reason in `problem`. With none held, `state: unavailable`: never an empty inbox. A topic value that fails its own schema is never left standing as fresh: the topic goes `stale` (`source_unavailable`). A row that can't be built is dropped, not the topic. `empty` is true only for an ok feed with no rows and nothing left out.
- **Incomplete feeds.** `incomplete` carries the counts and the feed's `errors` whenever either exists. Left-out questions (`omitted.question_ids`, at most 20 at a time, 4 per pass) and cut groups are opened with `app show` and published as rows; ones not opened yet are counted in `incomplete.unlisted`. A `show` that fails (busy, not migrated, unknown) is retried no sooner than 30 s later, for cut groups too. A `stale` refusal is final for that key: the bridge never asks again by itself (app-commands-v1). A left-out row that was opened is re-opened every 30 s, so `tokenFor(key)` can change under a row a client rendered earlier: every row carries a `rev` that covers its token (see Inbox acts).
- **Tokens.** Never in the topic. The bridge keeps each row's token (`InboxTopicDriver.tokenFor(key)`). Each row's `rev` is an HMAC (key random per bridge start) over the token it holds and the row as published, minus `new`: it reveals nothing of the token and changes whenever either does.
- **New.** The toast marks of the feed protocol: the first good feed announces nothing; after that a row above the marks is `new` for 60 s.
- **Unknown words.** An unknown row kind is published as `{key, kind, actions: [], new}`; an unknown delivery state as `known: false` with no actions; unknown severity, alert kind and asker host read as `warning`, `agent` and `unknown`. Remote rows are read-only (`actions: []`).

`startApp` (`packages/bridge/src/app/index.ts`) constructs the driver with `{hub, appHome, run, binaries}` and starts it, along with `PluginsTopicDriver`, `PanoramaTopicDriver`, `UsageTopicDriver` and `ChatTopicDriver`; `createBridgeServer` alone starts none of them.

## Inbox acts (S11)

`InboxTopicDriver.act(kind, args)` runs herdr-inbox's write verbs, `herdr-inbox app <verb> --json` through the launcher (herdr-inbox `docs/protocol/app-commands-v1.md`). Schemas: `bridgeApi.INBOX_ACTS`, `bridgeApi.InboxAct`; fixtures `fixtures/bridge-api/inbox-act/`. Every kind needs the `inbox.answer` capability and is audited by `Security.act`.

| `act` kind | verb | row | `args` (besides `key`, `rev`) |
|---|---|---|---|
| `inbox.answer` | `answer` | `group` | `question` + `detail` (a lone question), or `questions` (Submit: the stored drafts of these) |
| `inbox.draft` | `draft` | `group` | `question` + `detail`, or `question` + `clear: true` |
| `inbox.dismiss` | `dismiss` | `group` | `question?` (none: every open question of the group) |
| `inbox.retry` | `retry` | `failed` | none |
| `inbox.stop_showing` | `stop-showing` | `failed` | none |
| `inbox.ack` | `ack` | `alert` | none |

- **Bound to what was shown.** `key` and `rev` name the row as the phone drew it. The bridge acts only on a `rev` it published for that key, with the token that `rev` covers; any other is refused `stale` before the inbox is asked. So a token that moved under a rendered row (a re-opened left-out row, a newer feed) is never used for it, and the phone looks again. A `rev` the inbox answered `stale` for is refused here until the row changes: nothing is repeated with any token.
- **Labels are the bridge's.** `detail.choices` are option *indices*, and `detail.notes` are keyed by index. The bridge builds the Detail from its own copy of the question, with the plugin's own `verbArgs`; a label, a token or any unknown field in `args` is refused (`bad_args`). The option labels go to the audit log as `ActResult.audit_label` ("Phone 1 answered Q127 (Option B)"); a label the client sends is never logged, and free text is logged by length only.
- **Checked against the row.** A row kind that does not fit the act is `invalid`, a verb the row's `actions` do not list is `read_only`, a question not in the group, an index out of range, two picks on a single-select, or a one-shot answer on a group of several questions is `invalid`, and a detail over 64 KiB is `invalid`. None of these runs anything.
- **Results.** The plugin's own `readResult` reads the verb. Success is `ok: true` with the plugin's words for `queued`, `held` and skipped questions in `message`; a result with no token (the row is gone) adds `closed` (`answered`, `dismissed`, `acked`, `hidden`). A refusal is `ok: false` with the inbox's code (`stale`, `already_sending`, `invalid`, `read_only`, `busy`, `not_migrated`, `error`), the plugin's `refusalWords` as `message`, and for `stale` the inbox's `closed` word. Any other exit, bad stdout, a result naming another row, or a run past 8 s is `code: unknown_effect, unknown_effect: true`: the phone says so and the feed is reloaded; nothing is repeated.
- **Tokens after a verb.** The token of the bridge's last result is used for the row until a feed written after that result that lists the row, or a later `app show`, arrives (app-commands-v1; a left-out row never arrives in a feed). Until then the verb's effect is applied to the bridge's copy of the row (a draft stored or cleared, answered or dismissed questions gone), so the `rev`, the phone's view and the audit label all describe what the new token covers. The new `rev` is published before the `res` is sent, and the feed is read again. One verb runs at a time.
- **Touch.** The PWA keeps the inbox's own arm delays (`model/data.js`): a screen takes no action tap for 400 ms (`VIEW_ARM`) after it appears; after a change the operator did not cause (its row or the footer's row changed, a refusal came back) taps are dropped for 500 ms (`GRACE`); a row that has just arrived takes no tap for 1 s (`ROW_ARM`); a confirming tap (Dismiss) is armed on its own.
- **Known limitation (app-commands-v1).** `exec` has no stdin, so the answer (`--detail`) is on the verb's command line while it runs, for up to its 8 s budget. Any local user can read it from the process list then, although the feed is 0600. The bridge adds no other copy: it is not logged, and it never leaves the bridge in a result.
