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
| `bundle_sha256` | the bundle's hash, or null (set by the launcher, S12) |

The mod reads it before every connection attempt, so a restarted bridge with a new port or token is picked up. A missing or malformed file counts as a failed attempt (backoff applies).

## Handshake and authentication

The first line from the mod must be `hello`. The bridge checks `token` (constant-time, on sha256 digests) and keeps one connection slot per `copy`: a second authenticated `hello` with the same `copy` replaces the first (the older connection is closed), while `link` and `panel` never displace each other. Only the `link` copy's `state` feeds the `host` topic; a `panel` connection may send `result` for the commands routed to it and receives `notify`/`ping`.

Before a valid `hello` nothing is processed. The bridge closes the connection when the first line is not a `hello`, the `hello` is malformed or carries the wrong token, no line arrives within 5 s, or the preamble passes 16 KiB. A failed `hello` never displaces the current holder of a slot. A later `hello` on an authenticated connection is ignored.

There is no reply to `hello`; the first `ping` (or `run`/`notify`) is the first bridge line.

## Mod to bridge

| type | fields | notes |
|---|---|---|
| `hello` | `v: 1`, `token`, `copy: "link" \| "panel"`, `layout`, `app: {version}` | `copy` says which copy of the mod this is. `v` must be exactly 1. |
| `state` | `seq`, `host: HostState` | Sent from `render()` (and a 5 s recheck), deduplicated by content (the serialized `host` is compared with the last one sent on this connection), at most once per 100 ms, with at most one write in flight: a burst coalesces to its latest snapshot. |
| `result` | `id`, `ok`, `error?` | Answer to a `run` with the same `id`. `error` only when `ok` is false: `not_allowed` or `bad_args` when the mod refused it (nothing ran), `run_failed: <message>` when herdr's `run()` threw. |
| `pong` | | Reply to `ping`. |

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
| `notify` | `level: info\|warn\|error`, `message` | Shown by the mod as a toast titled "Remote" (`warn` is herdr's `warning`); at most 500 chars. |
| `ping` | | Keep-alive, every 15 s. The mod answers with `pong`. A copy that sends nothing for 37.5 s is disconnected. |

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

## Lifecycle

- The mod closes the socket in `close()`.
- The mod reconnects with exponential backoff from 0.5 s to 10 s (0.5, 1, 2, 4, 8, 10, 10, ...). A connection that received any message, or lasted 5 s, resets it to 0.5 s.
- `state.seq` is monotonic per connection. After a reconnect the mod starts again and sends a full `state`.
- Every `state` is a full snapshot, not a delta.

## Versioning

`v` in `hello` is the major version. Adding optional fields is not a version bump; removing or changing a field is.
