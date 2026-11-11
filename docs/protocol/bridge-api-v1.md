# bridge-api v1

The API between the PWA (and other clients) and the bridge. Source of truth: `packages/protocol/src/bridge-api.ts`. Fixtures: `fixtures/bridge-api/`.

## HTTP

`GET /api/v1/meta` returns `{api: 1, bridge: "<version>"}`.

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

Payload schemas defined so far: `host` is `HostState` (see mod-link v1), `plugins` is `{panorama, inbox, usage, hc, host}`, each `{state, detail?}`, and `panorama` is described below. The other payloads are defined by their slices; until then `snap.data` is open.

### Resume and consistency

- `seq` is per topic within an epoch. A `snap` sets the topic's `seq`; each `patch` for that topic carries previous + 1. `hello.resume.seqs` maps each topic to the last `seq` the client applied. `patch` carries no `epoch`: a bridge restart is detected through `welcome.epoch`, after which the client resubscribes and gets fresh `snap`s. A `seq` gap on a topic means the client re-subscribes to that topic only and receives a fresh `snap`.
- `snap.data` is validated against the topic payload schema where one is defined (`host`, `plugins`, `panorama`).
- Each bridge start gets a random epoch. A client that resumes with an unknown epoch, or whose seq has a gap, gets a fresh `snap`.
- iOS kills background sockets, so the PWA reconnects on `visibilitychange` and `online`.
- There is no optimistic UI: the UI changes only on `snap`, `patch` or `res`.

- A `stale` is cleared by the next `snap` of that topic (the bridge never patches across a stale period). A subscriber to a topic with no state yet receives no `snap` until the first one exists (for `host`, only `stale` `reconnecting` before the first link hello).
- `sub` always answers with the topic's current state, so re-subscribing is the recovery for a seq gap. `hello.resume` is honoured on the first `sub` of each topic: already current gets nothing, a gap within the bridge's last 64 patches is replayed, anything else gets a `snap`.
- A client that sends anything before `hello`, a second `hello`, invalid JSON, a binary frame or a frame over 64 KiB is closed.
- `act` answers `res {ok: false, code: "unsupported_action"}` until a slice registers a handler.

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
