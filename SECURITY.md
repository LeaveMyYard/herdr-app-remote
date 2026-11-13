# Security

herdr-app-remote lets a phone read, and optionally act on, a herdr-app running on your computer. This page says what it defends against, how, and which risks it accepts. The wire-level details are in [docs/protocol/bridge-api-v1.md](docs/protocol/bridge-api-v1.md) and [docs/protocol/mod-link-v1.md](docs/protocol/mod-link-v1.md); the design is in `docs/PLAN.md` section 2.

## What is protected

- Control of your agents and terminals: typing into a terminal, answering an agent's question, switching what herdr-app shows.
- What your agents are doing: names, states, question titles, terminal contents.
- Your tailnet's other services: this tool must not turn `tailscale serve` or the bridge into a way in.

## Threat model

In scope:

- another device on your tailnet, or a different tailnet user, reaching the bridge;
- a web page in a browser on your phone or computer attacking the bridge (CSRF, DNS rebinding, cross-site WebSocket);
- a stolen or lost phone;
- a request that arrives through Tailscale Funnel (the public internet);
- a bug that would make the phone a generic remote shell.

Out of scope (see "Accepted risks"): anything running as your own user on the computer, root, and a compromised Tailscale account or node.

## How it is defended

**Loopback only.** The bridge's two listeners (the API and the mod link) bind to `127.0.0.1`. The tailnet reaches the API only through `tailscale serve --bg --https=8443 http://127.0.0.1:47391`.

**Funnel never.** No command the bridge runs enables Funnel. The bridge checks `tailscale serve status --json` at start and every 30 s. While Funnel is on for the serve port, or for any handler that forwards to the API port, every request (even `/healthz`) answers `503 funnel` and live sockets are closed. Before the first verdict the bridge answers `503 starting`, and `503 funnel_unknown` while it cannot tell; after one, an unreadable check keeps the last verdict, so once Funnel was seen on, only a clean "off" serves again.

**Request guards**, in this order. Steps 1 to 3 apply to every request except `GET /healthz`; steps 4 to 6 apply to the WebSocket upgrade and to every non-GET request (step 6 except `POST /api/v1/pair`). A plain GET has no side effects, so the app shell and `GET /api/v1/me` need no cookie:

1. Remote access is not paused (`503 paused`).
2. `Host` equals the serve name exactly (DNS-rebinding guard).
3. `Tailscale-User-Login` equals the desktop owner's login. Tagged devices send none and are refused. This is a precondition, never the credential: any local process can forge the header on 127.0.0.1.
4. For the WebSocket upgrade and every non-GET request: `Origin` equals `https://<serve name>`.
5. Non-GET requests carry `X-Remote-Api: 1`; the WebSocket upgrade offers the subprotocol `herdr-remote.v1` instead, since browsers cannot set headers on it.
6. The device cookie names an approved device of the current owner login.

Host, identity and Origin failures all answer the same `403 forbidden`, so a probe learns nothing about which check failed. GET requests have no side effects. The CSP is `default-src 'self'` with no inline script; terminal and feed text is always rendered as text, never as HTML.

**Pairing and the cookie.** The desktop shows a one-time code (128 bits, 5 minutes, single use; a new code invalidates the old one). A phone that posts it becomes `pending` and receives a cookie, but it can do nothing until you approve it on the desktop. The cookie is `__Host-hr-device`, `HttpOnly; Secure; SameSite=Strict; Path=/`, holding a random 256-bit token; only its sha256 is stored (`devices.json`, mode 0600). Failed codes are rate-limited (10 a minute, global), at most 3 requests may be pending, and a pending request expires after 10 minutes. The phone never chooses its own name: the bridge calls it "Phone 1", "Phone 2", and the approval toast never shows a name. Revoking a device closes its sockets at once.

**Home Screen transfer.** A Home Screen web app on iOS has its own cookie jar, so the Safari cookie does not reach it. An approved phone with `view` can ask its bridge for a one-time transfer code (128 bits, 10 minutes, single use, bound to that device, held in memory only). The app reads the code from its `start_url` (`/pair#t=<code>`; the fragment is never sent in a request) and posts it once, and the device gets a second token of its own: the same device, name, capabilities and Activity, with Safari's token still working. Transfer never skips approval (a pending device cannot mint a code), a code redeems only as the device that minted it, a spent code voids the device's others, failed codes are rate-limited (10 a minute, global), and revoking, pausing, turning `view` off or a change of serve name or login voids unspent codes. Revoking a device removes both tokens. Whether iOS keeps the code when adding to the Home Screen is not yet verified on a real iPhone (RECIPE.md).

**Capabilities**, checked by the bridge on every action (the phone's own view of them is only a hint):

| capability | default | allows |
|---|---|---|
| `view` | on after approval | reading topics |
| `inbox.answer` | on | the inbox verbs: draft, answer, dismiss, ack, retry, stop showing |
| `navigate` | off | `agent.focus`, `tab.select`, `space.select`, `pane.focus` |
| `terminal.input` | **off** | `terminal.send` (`hc send`); desktop-only switch, with an optional expiry |
| `terminal.keys` | **off** | special keys from a fixed menu (`hc keys`); desktop-only switch, with an optional expiry |
| `push` | off | push subscriptions |
| `transcript.read` | **off** | chat history: agents' conversations (topics `chatview:<t>` and `timeline:<t>`, the chat history pages); desktop-only switch, no expiry |

`transcript.read` (chat history) is separate from `view`. `view` shows the screen: a terminal's last 200 lines. A transcript is days of an agent's conversation, so a stolen device cookie with it leaks far more; keeping it apart lets you pair a phone for questions only. It is off for every device, including those paired before it existed (a `devices.json` without it reads as off), and turned on only by the "Chat history" switch in the desktop Remote panel ("Lets this phone read agents' conversations, not just the screen."). It grants no action. The bridge checks it at every subscription to a transcript topic and answers a refused one `stale forbidden` with nothing sent; turning it off ends the device's open transcript subscriptions at once, without closing its socket. Activity records the switch ("Phone 1: transcript.read on") and refused subscriptions by terminal id only ("Phone 1 opened the chat of t3: refused, chat history is off", at most 4 a minute per device). `devices.json` keeps a strict schema, so a bridge from before this capability refuses to start on a file written by this one: there is no downgrade.

`terminal.keys` presses only entries of the desktop's own `keys.json` menu. The phone names an entry and never sends key names; each key token must be on a strict allowlist (control bytes and escape sequences, never plain text); presses are rate-limited (10 per 10 seconds per device); Activity records identifiers only, with no free text. A press whose effect is unknown is reported as "<label> may have been pressed. Check the terminal before you press it again." and is never resent by the app.

`terminal.input` and `terminal.keys` can be switched on only from the desktop Remote panel, for a chosen time or without limit; when the time is up the bridge turns them off by itself. There is no generic `run`, no `exec`, no arbitrary `herdr-app do`: any other action is refused and logged. The mod re-checks its own small allowlist (the four `navigate` commands) before running anything. `hc send` is called with `--` so text such as `--force` cannot be read as a flag, and never with `--force`.

**Rate limits**, per approved device: 20 WebSocket upgrades a minute, 30 actions per 10 s, 6 `terminal.send` per 10 s. A refusal is logged once per filled window.

**Audit without free text.** `activity.jsonl` (mode 0600, rotated at 1 MiB, three old files kept) records pairing, approvals, capability changes, pause, connections and every action with its outcome. It stores identifiers and lengths only: "Phone 1 sent 12 chars to t3". It never stores what you typed or an answer's text. For an inbox answer it records the option label the bridge looked up itself ("Phone 1 answered Q119 (Option B)"); a label sent by the phone is never logged. Push audit lines carry identifiers, never titles or endpoints. If the log cannot be written, the panel says so, and `terminal.send` is refused until it can.

**Secrets stay on the computer.** The phone holds only its cookie. Inbox row tokens stay in the bridge, and each action is bound to the row version the phone was shown. Push uses VAPID keys in `vapid.json` (0600) and encrypted payloads; push endpoints are limited to the known push services. Push payloads show question titles ("Agent 1: Question Title 123") and a fixed word, never question text.

**Serve is handled with care.** Start serving refuses if the port already has a handler; Stop serving removes only a handler this bridge created and recorded; a serve config that someone else made is never changed. The bridge never runs `tailscale set`; for the Linux operator error it shows the command for you to run.

**Pause** refuses everything except `/healthz` and closes live sockets.

**Claude history reader** (chat view, docs/chatview.md §2.2; the `chatview:<t>` topic below serves it). Claude Code history is read only through the pinned Claude Agent SDK's `getSessionMessages` and `getSessionInfo`, never by parsing transcripts in the bridge:

- The Claude config dirs come only from herdr-agent-usage's profile list (`[[claude.profiles]].config_dir` in its `config.toml`, read-only). There is no `~/.claude*` scan, no `$CLAUDE_CONFIG_DIR` source and no fallback; without a usable list the reader reports `no_profiles`.
- Each distinct `projects` dir gets its own child process (`claude-reader.mjs`), so the parse cost and the SDK stay out of the bridge process. A child gets a clean environment (`CLAUDE_CONFIG_DIR` and `HOME` only: no tokens, no `NODE_OPTIONS`) and runs under Node's permission model, allowed to read only its own script and its `projects` dir (`<config dir>/projects` and that path's realpath). It is not granted the rest of the config dir, so it cannot open `.credentials.json` or other account files directly. Node's permission model follows symlinks, though, so a symlink inside `projects` that points out of it would be followed (the child cannot create one: writes are denied). It cannot write files or start processes, so it can never start Claude Code.
- At most 4 children run at once. A child exits after 60 s idle and is killed by its own pid when a call takes over 5 s, its RSS goes over 512 MB, or a reply is over 64 MB.
- A session is bound to a reader only through the transcript path panorama proved (the realpath of its `projects` dir), or, failing that, a reader that finds the session id. The transcript is never opened by the bridge.
- What a read returns is checked block by block; thinking text and tool output are dropped before anything else sees it, and an unexpected shape makes the history unavailable rather than guessed.
- The bridge runs only the reader it was built with: the build puts `claude-reader.mjs`'s sha256 into `bridge.mjs` (the installer records the same hash), and the file is hashed before every start. Another file (edited, swapped, left from another build) is never run, and the chat view says `reader_failed`.

**Chat view topic** (`chatview:<t>`, docs/chatview.md §2, §3, §5; CV3). It needs `view` and `transcript.read`, like its older pages (`GET /api/v1/chatview/<t>`).

- **Only panorama's proved binding is used.** A session is shown for terminal `t3` only when panorama's feed has exactly one root at that exact address, joined to the one live agent there, with a verified session id. An aged or stale feed, a conflict, or no session id hides the chat view (the phone shows the terminal); it is never guessed from cwd, titles or recency. Showing the wrong session is the worst correctness failure, so a binding that changes drops the history held and starts over.
- **The transcript is never opened by the bridge.** While a chat is open it is stat'ed once a second (size and mtime); the history is read through the reader child only when they change.
- **What leaves the bridge** is prompt and reply text, AskUserQuestion text and options, tool names, file base names and counts. Tool inputs and outputs, thinking, attachments, hook context, system prompts, subagent messages, transcript paths, config dir names and session ids never do; item ids are message uuids, opaque to the phone. One tool id does leave (CV5): an `ask` item for a herdr-inbox `ask_operator` call (matched by its exact tool names only) carries that call's `tool_use_id`. The same id is a `timeline:<t>` item's `anchor`, set only when that terminal's own open chat view holds it and exactly one of its inbox questions claims it. The id is opaque; it is never put on the `inbox` topic.
- **Harness context never shows.** Reminders, hook output, IDE context (open files, selections) and command output that Claude Code puts into a user turn are removed in every block; anything left that is only tags is dropped too (fail closed).
- **Limits.** Each text block is cut at 16 KB and each message at 32 KB; the topic carries the newest 100 items in at most 512 KB, and a page at most 50 items.
- **Redaction is best effort.** Known secret shapes (`sk-ant-…`, GitHub `gh?_…` and `github_pat_…` tokens, AWS `AKIA…`/`ASIA…` key ids, Slack `xox?-…` tokens, PEM private key blocks, `Authorization: Bearer …` and a bare `Bearer` token) become `[hidden]` before anything is sent. A secret in another shape, or split across messages, is sent as the agent or you wrote it. Chat history is off by default for that reason too.
- **Audit.** Activity records "Phone 1 opened the chat of t3" and "Phone 1 opened the timeline of t3" (CV5, `timeline:<t>`, which needs the same `view` and `transcript.read`) once per subscription, and each older page by count ("Phone 1 loaded 50 earlier messages of t3"), never text. Each is refused while Activity can't be written (`audit_unavailable`), as typing is. The pages need the API marker header and, when sent, the exact Origin, and are limited to 20 per 10 s per device.

## Accepted risks

These are known and accepted for v1.

- **The mod does not authenticate the bridge.** The bridge proves nothing back to the mod. If a bridge dies and leaves `runtime.json`, another local process could bind the stale port, receive the link token and host state, and show text as a toast. The mod only trusts a runtime file that names the installed bundle hash and a live pid, and its `run` commands stay limited to the navigate allowlist, so nothing outside that list can run. A process that binds the port while the real bridge is alive, or a reused pid, still gets through. A challenge-response handshake is a candidate for v2.
- **Inbox answer text is on a command line for up to 8 seconds (the verb's time limit).** herdr-inbox's verbs take the answer as `--detail ...` (its protocol has no stdin form), so while a verb runs any local user can read it in the process list. The bridge adds no other copy.
- **Terminal input is on `hc send`'s command line** while a send runs (up to 15 s, because `hc` holds a send while someone types at the desktop), visible to local users the same way. `hc` has no stdin form for send.
- **Serve config is global to your Tailscale node.** `tailscale serve` has no compare-and-set. A handler mounted on `:8443` between the bridge's read and its command could be replaced by Start or removed by Stop. The window is a process spawn wide, and nothing else can make the bridge change a config it did not create. Other tools that use `tailscale serve` on the same port will collide, and the bridge refuses rather than overrides.
- **Anything running as your user can do what the bridge can.** A local process with your user rights can read `runtime.json` (mode 0600), `devices.json` and the audit log, and talk to the panel channel. The cookie, the identity header and the token do not defend against it, and `tailscale serve`'s headers can be forged on loopback. Local malware is out of scope.
- **The tailnet is a trust boundary.** The owner login check means another user of the same tailnet is refused, but a compromised Tailscale account, or an admin of your tailnet, is not defended against.
- **A lost phone** is protected by the phone's own lock and by revoking it from the desktop; the cookie is long-lived (400 days) and is not bound to the device hardware.
- **The Claude reader runs third-party code with your user's read rights.** The pinned Claude Agent SDK runs in the reader children. Node's permission model limits a child to reading its `projects` dir and denies writes and child processes. It follows symlinks, so a symlink placed inside `projects` (which takes your user's rights; the child can't make one) would extend the child's read access to its target, such as the credentials next to it. On Node 24 and older it does not limit network access (`--allow-net` arrives in Node 25), and every reader of a shared (symlinked) `projects` dir can read every session in it. The exact pin and the rig test limit drift; a compromised SDK release would still have read access to the transcripts.
- **Chat history shows what the agent and you wrote.** With `transcript.read` on, the phone can read whole conversations, including anything pasted into them; the secret redaction is best effort. A stolen cookie with chat history on can read that history until it is revoked or the switch is turned off.
- **iOS** kills background sockets and can let push subscriptions lapse; the app reconnects when it comes back, and never retries an action by itself when its outcome is unknown.

## Reporting a problem

Please do not post details of a vulnerability in a public issue. Use GitHub's private vulnerability reporting on this repository if it is available, or open an issue that asks for a private channel and contains no details.
