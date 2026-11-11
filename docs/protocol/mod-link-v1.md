# mod-link v1

The link between the `herdr-app-remote` mod (inside herdr-app) and the bridge.
Source of truth: `packages/protocol/src/mod-link.ts` (zod schemas). Fixtures: `fixtures/mod-link/`.

## Transport

NDJSON over TCP: one JSON object per line, UTF-8, `\n` terminated. The bridge listens on `127.0.0.1` only (the "link" port). The mod connects with `net.connect("127.0.0.1", port)`.
Every message has a `type` field. A line that is not valid JSON, or does not match a schema for its direction, is a protocol error and is dropped (the bridge logs it; it does not close the link for a single bad line).

- Bridge-to-mod lines are pure ASCII: non-ASCII is `\uXXXX`-escaped (`encodeLine`), so the mod splits and decodes them byte-wise.
- Line limits (`LINE_LIMITS`): 16 KiB before a valid `hello`, 8 MiB per mod-to-bridge line after it, 1 MiB per bridge-to-mod line. A peer that goes past its limit is disconnected.

## Finding the bridge: `runtime.json`

The bridge writes `<app home>/data/herdr-app-remote/runtime.json` (`RUNTIME_RELATIVE_PATH`), mode 0600 in a 0700 directory, atomically (temp file + rename):

| field | notes |
|---|---|
| `v` | `1` |
| `port` | the link port |
| `token` | 256-bit random, base64url; 32 to 256 chars |
| `pid` | the bridge's pid; it removes the file on exit only if the pid is still its own |
| `bundle_sha256` | the sha256 of the bundle this bridge runs (checked against `install.json` at start), or null for a bridge not started from an install |

The mod reads it before every connection attempt, so a restarted bridge with a new port or token is picked up. A missing or malformed file counts as a failed attempt (backoff applies).

Before connecting, both copies check that the runtime is trustworthy (`trustRuntime` in `mod/herdr-app-remote/install.js`): `bundle_sha256` must equal the bundle hash in `data/herdr-app-remote/install.json`, and `pid` must be alive (`kill -0`). Otherwise the attempt counts as failed and the token is never sent. A null `bundle_sha256` is never trusted by the mod.

## Starting the bridge

The `link` copy starts the bridge when an attempt finds no usable one (no runtime, an untrusted one, or a refused connection), at most once per 10 s:

1. It reads `install.json` (`packages/protocol/src/install.ts`), hashes `data/herdr-app-remote/bin/bridge.mjs` and compares; a mismatch launches nothing.
2. It runs `exec(<node from install.json>, [<bundle>, "launch", "--app-home", <app home>])`: argv only, no shell.
3. `launch` checks the bundle again, returns at once when a live bridge runs this same bundle, and otherwise starts `serve` detached (its own session, stdio closed) under `flock -n data/herdr-app-remote/bridge.lock` where flock(1) exists. Where it doesn't (stock macOS), `serve` refuses to start while another live bridge answers, and a bridge whose runtime.json was overwritten by another pid stops (`replaced`).

The `panel` copy never launches. A bridge stops by itself (and removes its runtime.json) when the install record goes (`uninstalled`), when the record names another bundle (`superseded`, after an upgrade; the new bundle then takes the lock), when runtime.json names another pid (`replaced`), or when no `link` copy has been connected for 30 s and the app's socket (`<app home>/herdr-app.sock`) is gone or refuses (`app_gone`). It stays up while the app runs a layout without the link block, so the phone can show `layout_without_remote`.

## Handshake and authentication

The first line from the mod must be `hello`. The bridge checks `token` (constant-time, on sha256 digests) and keeps one connection slot per `copy`: a second authenticated `hello` with the same `copy` replaces the first (the older connection is closed), while `link` and `panel` never displace each other. Only the `link` copy's `state` feeds the `host` topic; a `panel` connection may send `result` for the commands routed to it and receives `notify`/`ping`.

Before a valid `hello` nothing is processed. The bridge closes the connection when the first line is not a `hello`, the `hello` is malformed or carries the wrong token, no line arrives within 5 s, or the preamble passes 16 KiB. At most 8 connections may wait for a `hello` at once; a new one evicts the oldest waiting one, so idle sockets can't keep the mod out. A failed `hello` never displaces the current holder of a slot. A later `hello` on an authenticated connection is ignored.

There is no reply to `hello`; the first `ping` (or `run`/`notify`) is the first bridge line.

## Mod to bridge

| type | fields | notes |
|---|---|---|
| `hello` | `v: 1`, `token`, `copy: "link" \| "panel"`, `layout`, `app: {version}` | `copy` says which copy of the mod this is. `v` must be exactly 1. |
| `state` | `seq`, `host: HostState` | Sent from `render()` (and a 5 s recheck), deduplicated by content (the serialized `host` is compared with the last one sent on this connection), at most once per 100 ms, with at most one write in flight: a burst coalesces to its latest snapshot. |
| `result` | `id`, `ok`, `error?` | Answer to a `run` with the same `id`. `error` only when `ok` is false: `not_allowed` or `bad_args` when the mod refused it (nothing ran), `run_failed: <message>` when herdr's `run()` threw. |
| `pong` | | Reply to `ping`. |
| `panel_act` | `id`, `kind`, `args` | **`panel` copy only** (from the `link` copy it is dropped and logged). A desktop-only operation for the Remote panel; see "Panel" below. `id` is 1 to 128 chars, `kind` at most 64. |

`HostState` (shared with the bridge-api `host` topic):

- `spaces[]`: `{id, name, focused}`
- `agents[]`: `{id, name, harness, state, space_id, terminal_id?}`, `state` in `idle|working|waiting|done|error|unknown`
- `terminals[]`: `{id, title, space_id, cols, rows}`
- `panes[]`: `{id, space_id, terminal_id?, kind}`
- `focused`: `{space_id, pane_id, agent_id}`, each nullable
- `theme`: `{name, mode: "dark"|"light"}`
- `layout_name`
- `shared`: `{"panorama.feed.owner": string | null}`: the `role` (`sidebar` or `consumer`) of a live panorama lease (`v` 1, a token, `seen_at` within the 15 s TTL), else null. The lease token never leaves the app.

How the mod fills it from herdr-app (`mod/herdr-app-remote/host.js`): agent and terminal ids are terminal addresses; a terminal's or pane's `space_id` comes from its tab (`spaces()[].tabs`) or its agent, and one with no known space is left out; agent `blocked` maps to `waiting`; `theme.name` is `settings().theme` (else `default`) and `mode` is light only when `settings().dark` is false; `layout_name` is `shared("layout")`.

## Bridge to mod

| type | fields | notes |
|---|---|---|
| `run` | `id`, `name`, `args` | `name` and `args` must pass the allowlist below. The mod checks it again itself and answers with `result`. A `run` without a string `id` of 1 to 128 chars is ignored. |
| `notify` | `level: info\|warn\|error`, `message`, `action?: "open_panel"` | Shown by the mod as a toast titled "Remote" (`warn` is herdr's `warning`); at most 500 chars. `open_panel` makes a click on the toast run the mod's own `open` command (shows the Remote panel); it is the only action there is. The bridge uses it for "Approve Phone 1?". |
| `panel` | `seq`, `view: PanelView` | Sent to the `panel` copy only: on its `hello`, and whenever the view changes (a security change at once, otherwise a 2 s recheck), deduplicated by content. A full snapshot. |
| `panel_res` | `id`, `ok`, `code?` | Answer to a `panel_act` with the same `id`. `code` when `ok` is false: `unsupported_action` and `bad_args` (refused, nothing done), `not_found`, `serve_not_configured`, `paused`, `unavailable`, `failed`; for `setup.*`, `no_setup` (this bridge runs no setup) or a setup problem code (`SETUP_PROBLEMS` in bridge-api). |
| `ping` | | Keep-alive, every 15 s. The mod answers with `pong`. A copy that sends nothing for 37.5 s is disconnected. |

### Panel

The desktop Remote panel (S13) is the `panel` copy (layout props `role: "panel"`). It never sends `state`. The bridge pushes it a `PanelView` and it asks for desktop-only operations. Schemas: `PanelView`, `PanelAct`, `PANEL_ACT_ARGS` in `packages/protocol/src/mod-link.ts`; driver: `packages/bridge/src/panel/driver.ts`.

`PanelView` has `status` (`serving`, `paused`, `setup`, `blocked`), `url`, `checks[]` (`{id, label, detail, state: ok|warn|bad|off}`), `devices[]` (name, login, `pending|approved`, the five effective capabilities, `terminal_input_until`, `last_seen`, `live`), `plugins[]` (state and the phone tabs each powers), `activity[]` (newest first, 100 at most), `pairing` (the URL and the QR as rows of `0`/`1`, present while a code is valid) and `setup` (the `setup` topic's payload, `SetupTopic` in bridge-api; null when the bridge was given a fixed serve identity and runs no setup). While `status` is `setup` and `setup` is set, the mod draws the Setup view (design/DesktopSetup) in place of the tabs: the five steps, the current step's problem (its `fix` command shown to copy, never run; its `url` opened only when it is a `https://login.tailscale.com/` page), "Check now" and "Start serving" (enabled only on `can_start`). "Stop serving" sits on the Status tab when `can_stop`, behind a second click. Every text is bounded, drawn as text only, and the view never carries tokens, cookies or token hashes. The mod checks it again (`sanitize` in `mod/herdr-app-remote/panel.js`) and drops a device whose id is not `d-` plus 16 hex digits.

`panel_act` kinds (strict: each takes exactly these keys, anything else is `unsupported_action` or `bad_args` and nothing happens):

| `kind` | `args` |
|---|---|
| `device.approve` | `{id}` |
| `device.revoke` | `{id}` (refuses a pending request, revokes an approved device; its sockets drop now) |
| `device.cap` | `{id, cap: view\|inbox.answer\|navigate\|terminal.input\|push, on, minutes?}`. `minutes` (1 to 10080) only with `cap: terminal.input` and `on: true`; the bridge turns it into an expiry on its own clock, none means no expiry. |
| `remote.pause`, `remote.resume` | `{}` |
| `pair.code` | `{}`: a fresh pairing code, shown as a QR in the next view |
| `pair.hide` | `{}`: hides it from the panel |
| `setup.check` | `{}`: reads the Tailscale state again ("Check now") |
| `setup.start` | `{}`: "Start serving": `tailscale serve --bg --https=8443 http://127.0.0.1:<api>`, only when the port has no handler (S14 rules) |
| `setup.stop` | `{}`: "Stop serving": removes only the handler this bridge created and recorded |

The `setup.*` acts take no arguments: the port, the target and every command line are the bridge's own, and nothing the panel sends reaches a command. Every finished Start and Stop is written to Activity from its outcome code only (e.g. "Start serving failed (operator)"), never CLI output. Start and Stop may wait on `tailscale serve` (cut off after 20 s), so the mod waits up to 90 s for their `panel_res`.

These are the same operations the security layer offers the desktop; they are not `act` kinds, so no phone can reach them, and they run no herdr command. The run allowlist below is unchanged. Capabilities (above all `terminal.input`) can only be switched here. The panel trusts the same runtime token as the link; any local process with that token (the same user) can send `panel_act`, as it could already edit `devices.json`.

### Run allowlist

`RUN_ARGS` in `packages/protocol/src/mod-link.ts`, mirrored by `mod/herdr-app-remote/allowlist.js` (a parity test keeps them equal). These are the `navigate` capability's commands; nothing else, and no extra argument keys:

| `name` | `args` (exactly one form) |
|---|---|
| `agent.focus` | `{terminal: Id}` |
| `pane.focus` | `{pane: Id}` or `{terminal: Id}` |
| `space.select` | `{id: Id}` or `{index: Index}` |
| `tab.select` | `{id: Id}` or `{index: Index}` |

`Id` matches `^[A-Za-z0-9._:/-]{1,128}$`; `Index` is an integer from 1 to 10000.

The bridge's `run()` resolves to `{ok: true}` or `{ok: false, code, error?, unknown_effect}`. `unknown_effect` is false only when nothing can have run (`not_allowed`, `bad_args`, `no_link`) and true for `failed`, `timeout` (10 s) and `link_lost`: the caller must not retry those by itself.

## Copies

A copy links only when its layout props say `role: "link"` or `role: "panel"`. A copy with any other props (opened with `mod.open`, `tab.new {mod}` or a hand-made block) renders an empty block and never connects, so it can't compete with the real link for its slot.

## Security notes

- The bridge authenticates the mod (the token); the mod does **not** authenticate the bridge. If a bridge dies without removing `runtime.json`, another local process (another user too) could bind the stale port. The mod would then send it the token and the host state, and show its `notify` text as a "Remote" toast. The token is useless once the real bridge has rotated it, and `run` stays limited to the mod's own navigate allowlist, so no command outside that list can run. This is a residual risk on multi-user machines, accepted for v1. It is narrowed by the trust check above (the runtime must name the installed bundle and a live pid the user can signal, so a dead bridge's stale file is ignored), but not closed: a process that binds the port while the real bridge is alive, or a reused pid, still gets through. A v2 handshake can close it by having the bridge prove the token (an HMAC over a nonce from the mod's `hello`).
- The bridge's `run()` sends the schema-parsed copy of `args`, never the caller's object.

## Lifecycle

- The mod closes the socket in `close()`.
- The mod reconnects with exponential backoff from 0.5 s to 10 s (0.5, 1, 2, 4, 8, 10, 10, ...). A connection that received any message, or lasted 5 s, resets it to 0.5 s.
- `state.seq` is monotonic per connection. After a reconnect the mod starts again and sends a full `state`.
- Every `state` is a full snapshot, not a delta.

## Versioning

`v` in `hello` is the major version. Adding optional fields is not a version bump; removing or changing a field is.
