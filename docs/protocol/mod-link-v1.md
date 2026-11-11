# mod-link v1

The link between the `herdr-app-remote` mod (inside herdr-app) and the bridge.
Source of truth: `packages/protocol/src/mod-link.ts` (zod schemas). Fixtures: `fixtures/mod-link/`.

## Transport

NDJSON over TCP: one JSON object per line, UTF-8, `\n` terminated. The bridge listens on `127.0.0.1` only (the "link" port). The mod connects with `net.connect`.
Every message has a `type` field. A line that is not valid JSON, or does not match a schema for its direction, is a protocol error and is dropped (the bridge logs it; it does not close the link for a single bad line).

## Handshake and authentication

The first line from the mod must be `hello`. The bridge checks `token` and keeps a single link: a second authenticated `hello` replaces the first. No other message is processed before a valid `hello`.

## Mod to bridge

| type | fields | notes |
|---|---|---|
| `hello` | `v: 1`, `token`, `copy: "link" \| "panel"`, `layout`, `app: {version}` | `copy` says which copy of the mod this is. `v` must be exactly 1. |
| `state` | `seq`, `host: HostState` | Sent from `render()`, deduplicated by a hash of its content, at most once per 100 ms. |
| `result` | `id`, `ok`, `error?` | Answer to a `run` with the same `id`. |

`HostState` (shared with the bridge-api `host` topic):

- `spaces[]`: `{id, name, focused}`
- `agents[]`: `{id, name, harness, state, space_id, terminal_id?}`, `state` in `idle|working|waiting|done|error|unknown`
- `terminals[]`: `{id, title, space_id, cols, rows}`
- `panes[]`: `{id, space_id, terminal_id?, kind}`
- `focused`: `{space_id, pane_id, agent_id}`, each nullable
- `theme`: `{name, mode: "dark"|"light"}`
- `layout_name`
- `shared`: `{"panorama.feed.owner": string | null}`

## Bridge to mod

| type | fields | notes |
|---|---|---|
| `run` | `id`, `name`, `args` | `name` must be on the allowlist (defined with the link mod, S2). The mod checks the allowlist again itself and answers with `result`. |
| `notify` | `level: info\|warn\|error`, `message` | Shown by the mod as a toast. |
| `ping` | | Keep-alive. |

## Lifecycle

- The mod closes the socket in `close()`.
- The mod reconnects with exponential backoff from 0.5 s to 10 s.
- `state.seq` is monotonic per connection. After a reconnect the mod starts again and sends a full `state`.
- Every `state` is a full snapshot, not a delta.

## Versioning

`v` in `hello` is the major version. Adding optional fields is not a version bump; removing or changing a field is.
