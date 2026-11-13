# Chat view spec (herdr-app-remote)

Status: approved 2026-11-13 (operator). Not implemented. Decisions are listed in §12. For Claude Code the chat is the only view; native prompts are chat cards; the composer is text plus Stop. Board: `design/PhoneChatView.dc.html` (sheets `chatview-sheet-1.png` and `chatview-sheet-2.png`). Fake data only.

## 1. Goal

On the phone, a live agent's Chat screen shows the conversation as chat, read from the agent's own history:
- your prompts as right-aligned bubbles;
- the agent's replies as markdown text;
- each run of tool calls collapsed into one row ("Ran 1 shell command");
- thinking hidden;
- the agent's questions, and herdr-inbox questions and alerts, inline where they were asked;
- a working or idle line.

- Claude Code's native interactive prompts are chat cards answered with buttons (§3a): permission requests, AskUserQuestion (single, multi-select, Other), plan approval, and any other option list the screen shows.

**For a supported harness (Claude Code), the chat is the only view.** There is no terminal toggle, no key bar and no Keys menu.
- The composer is text only. It still sends with `hc send` (`terminal.send`, needs `terminal.input`), so typing works as it does today.
- While the agent works, the composer shows **Stop**, which presses Esc once (§3a.6).
- While a native prompt is open, the composer is locked: "Answer the prompt above first".

**Text view.** Codex (in v1), unknown harnesses, and a Claude agent whose chat source is unavailable (§6) keep today's text view: the raw terminal, the ⏎ and / key bar, and the Keys menu (S16b), all unchanged.

Scope: v1 is Claude Code only.

## 2. Data source and mapping

### 2.1 Pane to session: reuse panorama, no second guesser

The bridge already reads panorama's feed v2 (`<appHome>/data/panorama/feed.json`, validated with panorama's hash-pinned `contract.js`) and joins a root to a host agent only by exact terminal address (`host == "herdr-core"`, `root.terminal == agent.terminal_id`).

The chat view uses that join and nothing else:
- **Session.** Panorama proves the session id (`src/host/link`). It combines two signals: Claude's per-process `sessions/<pid>.json`, checked against `/proc` (pid, start token, `HC_TERMINAL_ID`), and its own SessionStart hook records. It refuses on any conflict, and it never uses cwd, mtime or "newest file".
- **What the root gives.** `root.session_id` (after following `continued-in`), `root.cwd`, `root.harness` and `root.transcript`, the absolute path of the main JSONL.
- **When the feed proves nothing, there is no chat view.** That covers no lease owner (basic mode), an `aged` feed (older than 15 s, so no joins), `session_id` null, and a join that fails. The phone falls back to the terminal (§6).
- **Transcript paths never reach the phone** (bridge-api v1 already says so). The bridge uses `root.transcript` only to choose a config root (§2.2). It never opens the file to parse it.

### 2.2 Claude Code: read through the Agent SDK, one reader per config root

Operator decisions (2026-11-13):
- History is read with `@anthropic-ai/claude-agent-sdk` (`getSessionMessages`, `getSessionInfo`). The JSONL format is internal, so the bridge never parses it.
- Every Claude config dir the operator uses is a hard requirement. They are listed only by herdr-agent-usage's profile list.

What was checked, in a private test HOME with fake transcripts only (SDK 0.3.312):

| check | result |
|---|---|
| terminal-started sessions (`entrypoint: cli`) | listed and read |
| config root | exactly one: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. A session under `~/.claude-2` is invisible unless `CLAUDE_CONFIG_DIR` points there. |
| env read per call | yes: changing `process.env.CLAUDE_CONFIG_DIR` between calls switched roots. This is not memoized in 0.3.312, but it is not a contract, and it races with concurrent async calls. |
| `SessionMessage` shape | `type`, `uuid`, `session_id`, `message` (raw API payload: role, content blocks `text`/`thinking`/`tool_use`/`tool_result`, or a plain string), `parent_tool_use_id`, `parent_agent_id`, plus an untyped `timestamp` |
| `limit`/`offset` | counted from the start of the chain; each call still parses the whole file |
| cost | 20k messages, 24 MB: about 110 ms per call, RSS about 300 MB |
| half-written last line | ignored, no error |
| native binary | not needed: the 281 MB `claude-agent-sdk-<platform>` optional package can be omitted (`--omit=optional`), and reading still works |

**Design.**
- **Config roots.** The bridge builds the root list from one source only: herdr-agent-usage's Claude profiles (`[[claude.profiles]].config_dir` in its config, read-only, the same file `usagebar` uses).
  - There is no `~/.claude*` scan, no `$CLAUDE_CONFIG_DIR` source and no fallback.
  - If agent-usage isn't installed or its config can't be read, the Claude chat view is unavailable (`no_profiles`, §6) and the phone shows the text view with a notice.

  Roots are deduplicated by the realpath of `<dir>/projects`. If several profiles' `projects` dirs are symlinks to one dir, they collapse to one reader. The design doesn't depend on that.
- **Choosing the root for a session.** Take the realpath of the `projects` dir that holds `root.transcript` (its grandparent) and match it against the roots' projects realpaths. If nothing matches, fall back to `getSessionInfo(id, {dir: cwd})` in each agent-usage reader (no other roots are tried), and use the first that returns it. If none does, the chat view is unavailable (`no_binding`, §6).
- **One reader child process per distinct projects root**, spawned with `CLAUDE_CONFIG_DIR=<root>` and a clean env (no tokens). It is a small Node script that imports only the session functions and speaks line-delimited JSON over stdio.
  - It is started on first use and exits after 60 s idle.
  - At most 4 run at once.
  - It is killed if RSS goes over 512 MB or a call takes over 5 s.

  This keeps the 300 MB parse out of the bridge process and avoids mutating the bridge's env. The SDK never runs `query()`, so it never starts Claude, spends tokens or writes anything.
- **Pin** an exact SDK version, at least two weeks old when the slice starts (today that would be 0.3.312). Install with `--omit=optional`, and record it in THIRD-PARTY. A rig test runs the reader against fixture transcripts, so an SDK bump that changes the shape fails CI, not the phone.

**Implemented in CV2** (`packages/bridge/src/claude/`; the topic is CV3):
- `discoverRoots` reads the profile list from `<agent-usage config dir>/config.toml`, where the dir follows `<appHome>/mods/agent-usage/local.json` `configDir` like the usage topic (default `~/.config/agent-usage`). Entries are kept as agent-usage's own `validateSpec` keeps them. `no_profiles` has a detail: `missing`, `unreadable`, `invalid`, `empty` or `no_projects`. Zero `[[claude.profiles]]` is `empty`: agent-usage's implicit `~/.claude` default is not used, since it would be a fallback.
- `ReaderPool` runs the children (`dist/claude-reader.mjs`, installed as `data/herdr-app-remote/bin/claude-reader.mjs`) under Node's permission model, read-only on the script and the projects dir (`<configDir>/projects` and its realpath; never the config dir, which holds the credentials). A call runs one at a time per child. The child's own idle timer fires a second after the bridge's, as a backstop.
- `ClaudeHistory.bind` and `read` return typed results with the §7 reasons (`no_profiles`, `no_binding`, `reader_failed` with a detail). `read` checks every message (`checkMessages`, unavailable above a 10% failure share) and drops thinking text and tool output before CV3 sees them. Messages of an unknown type count toward the failure share. An empty first page is checked with getSessionInfo: `ok` with no messages means the session exists and is empty, and `not_found` means this reader can't see it at all.
- Found with the fixtures (pinned in `fixtures/claude/expected`): SDK 0.3.312 gives `system` messages **no `subtype`**, so a `compact_boundary` can't be told apart from other system messages. The compaction summary that follows it comes as a `user` message with `isCompactSummary` and `is_meta`, which CV3 can use for the divider instead. `isMeta` caveats and sidechain entries are already left out by the SDK, and a half-written last line is ignored.

**Tailing.**
- While someone is subscribed, the bridge stats `root.transcript` once a second. That is the only file operation on it, and only size and mtime are read.
- When either changes, it asks the reader for the session. The bridge diffs by `uuid` and publishes a patch.
- If the uuid chain is rewritten (compaction, rewind, `continued-in` moving `session_id`), it publishes a fresh `snap`.

**Implemented in CV3** (`packages/bridge/src/chatview/`; payloads in bridge-api v1, `chatview:<t>`):
- **Binding** (`resolve`): the host agent's program key decides `harness` first (a Codex pane needs no panorama). Then: no lease owner, no feed or no verified contract is `no_panorama`; an aged or stale feed (checked again at use: the contract's `aged`, and a snapshot older than 3 s), no root or two roots at `host == "herdr-core"`, `terminal == t`, no live agent or two at the address, no uuid `session_id` or no absolute `transcript` is `no_binding`. The proved `{session_id, transcript, cwd}` goes to `ClaudeHistory.bind`; a change of any of the three binds again and starts over.
- **Tail**: a 1 s stat (size, mtime) of `root.transcript`; a read only when either changed (or the binding did). A read that is `not_found` while the stat saw a size > 0 (or the stat itself fails) is `reader_failed`; `not_found` with no file or an empty one is an empty chat ("No messages yet"). A bind or read failure drops the items held and is retried after 5 s.
- **Diff**: items are compared by id. The same chain gives a patch: a window that slid by k items is k removes at `/items/0` plus a diff, sent as the source's own ops (`Hub.publish(..., {ops})`). A chain whose old ids are not a prefix of the new ones (compaction, rewind) or another session gives a fresh `snap` and a new random `rev`.
- **Mapping** (`mapMessages`): as §3, with these choices: one row per run of tool calls, `kind` the shared kind or `other` for a mixed run; thinking does not break a run, text, a prompt, an ask item or a divider does; a tool row counts `running` calls with no result yet (the phone spins only while the host says working). AskUserQuestion is an `ask` item per question (§3a cards are CV7). The compact divider comes from the summary marker (`isCompactSummary`), as CV2 found. Harness wrappers are removed from every text block of a user turn (reminders, hook output, `ide_*` context, command output, bash mode, any `system-*`/`command-*`/`*hook*` tag); a block left with only tags of any name is dropped (fail closed); tags are paired by a linear scanner (no backtracking regex runs on transcript text). Only `<command-name>` makes a chip, and only when nothing else is left, never with its arguments. An AskUserQuestion call shares its message's 32 KB with the text and is cut to fit (`cut`). Day dividers use the bridge's local day.
- **Status line**: the topic's `status` field (`working` with `since` = the last prompt's time, `blocked` for the host's `waiting`, else `idle`), not an item, so it never shifts the item window.
- **Pages** come from the items an open chat view holds (the newest 5000 per open chat), so `GET /api/v1/chatview/<t>` answers `409 not_open` when it isn't open.
- **Audit**: the open is written by the topic gate at the `sub` that starts the subscription (`GateMode` `sub`, not `resub` or `recheck`); with Activity failing it is `stale audit_unavailable`.

### 2.3 Codex and others

- There is no SDK. Codex is **terminal-only in v1**.
- Later slice C1: read through `codex app-server` (`thread/read`, `thread/items/list`) with `CODEX_HOME` per profile, exactly as panorama does (`src/codex/history.rs`). The thread id is `root.session_id`, which panorama binds from its codex-bindings hook. Rollout JSONL is never parsed.
- Other harnesses: terminal only, until a harness has a supported history API.

## 3. What to render (Claude)

| source | shown as |
|---|---|
| `user`, string content, or `text` blocks, not `isMeta` | a "you" bubble. Text that only wraps a command (`<command-name>` and similar) shows as a one-line chip ("/compact"). |
| `user` with only `tool_result` blocks | nothing of its own. It closes the tool row it answers (an error turns the row amber: "1 command failed"). |
| `assistant` `text` | markdown, rendered by a safe renderer to React elements (§5.3) |
| `assistant` `thinking` / `redacted_thinking` | hidden |
| consecutive `tool_use` blocks, outside an inline item | one collapsed row, counted by kind: "Ran 2 shell commands", "Read 3 files", "Edited 2 files", "Searched 4 times", "Ran 3 subagents", else "Used 2 tools". A tap expands it to one line per call: the tool name and the file name only (never the command, input or output). |
| a `tool_use` still waiting for its result, while the agent works | the row ends in a spinner ("Reading 2 files") |
| `AskUserQuestion`, `ExitPlanMode`, or any `tool_use` with no result while the host says `blocked` | a native prompt card (§3a) |
| herdr-inbox `ask_operator` tool_use | replaced by the inbox item for that question (§4) when one exists, else an "Asked you a question" row |
| `system` messages | `compact_boundary` shows as a divider ("Earlier messages were summarised"). Everything else is hidden (`includeSystemMessages: true`, filtered). |
| subagent messages (`parent_tool_use_id` set) | not inline. The panorama strip (§4) links to Swarm and Peek. |
| a block type this version doesn't know | dropped. If a message has nothing left, it shows nothing. |

- **Status line** at the end: the host topic's agent status, not the transcript.
  - `working` gives a spinner with "Working · 1m 12s", timed from the last user message's `timestamp`.
  - `blocked` gives "Waiting for you", unless a prompt card already says it.
  - idle or done shows nothing.
- **Day dividers** come from `timestamp` ("Today 21:02"). Without one, there is no divider.

## 3a. Native prompts and Stop (Claude Code)

### 3a.1 What exists (documented)

Sources: code.claude.com/docs/en/hooks, permissions and permission-modes.
- **Permission prompt.** The options are "Yes", "Yes, and don't ask again for: `<prefix> *`", sometimes "Yes, and switch to auto mode", and "No". Esc cancels and Tab amends.
- **AskUserQuestion.** `tool_input.questions[]` holds `{question, header, options[{label, description}], multiSelect}`, and the prompt adds an Other field. It always prompts, even with allow rules.
- **Plan approval (ExitPlanMode).** `tool_input.plan` holds the plan. The options are "Yes, and use auto mode", "Yes, manually approve edits" and "No, keep planning", with variants: auto-accept, bypass, and a clear-context first option.
- **Other dialogs:** MCP elicitation (`elicitation_dialog`), MCP tools with `requiresUserInteraction`, and the workspace trust dialog (only at start).

Labels differ by version and by mode. So the phone never hard-codes labels: **option labels and their order always come from the live screen** (§3a.3).

Every option the screen shows is pressable from the phone, including "Yes, and don't ask again for: …" and the auto-mode plan option (decision 7, §12). The AskUserQuestion card answers only on its Answer button (decision 8).

### 3a.2 Detecting a pending prompt: read-only first

| signal | source | used for |
|---|---|---|
| T: the last assistant `tool_use` has no `tool_result` | SDK `getSessionMessages` (§2.2) | which tool, its `tool_use_id`, and the semantic content: the command or file (summarised, §5.2), the question text and option descriptions, the plan text |
| S: herdr's agent status is `blocked` | `host` topic | the agent is on a dialog, not just running a tool |
| V: the screen shows a prompt block | `hc read <t>` (as the text view reads it) | the exact option labels, their order, and which one has the cursor (`❯`) |

- A card appears only when **T, S and V agree**: the screen block matches the pending tool. For AskUserQuestion that means the same option labels in the same order, plus the Other field. For a permission prompt, the command summary must appear in the block.
- T alone (a tool running) gives a spinner row, not a card.
- S and V without T (a prompt the bridge can't classify: MCP elicitation, a trust dialog, or a new prompt type) gives a generic card: the screen's own title and labels as buttons, under the heading "Agent 1 asks". The same press rules apply. If no option list can be parsed, the card shows the screen's lines read-only, in a monospace block, plus "Answer it on desk-1." It has no buttons (decision 2, §12).

**Hooks were considered and are not used in v1.**
- `Notification` (`permission_prompt`, `elicitation_dialog`) and `PermissionRequest` (`tool_name`, `tool_input`, `permission_suggestions`) would give an exact, non-scraped signal.
- But they need installing into every config dir's settings, or a plugin enabled in each.
- And a `PermissionRequest` hook that *answers* would hold the desktop dialog while the phone decides: up to 600 s by default, and the docs don't say whether the dialog shows meanwhile.
- So v1 reads only. Later slice H1 may add a log-only plugin hook (`Notification` + `PermissionRequest` that returns no decision and exits at once) as a fourth signal that tightens matching. Hooks never answer.

### 3a.3 The prompt identity

The bridge publishes each card with:
- `prompt_id`: sha256 over the `tool_use_id`, the prompt's title line, and the ordered option labels from the screen;
- `rev`: an HMAC as for inbox rows.

The phone can only act on a `prompt_id` the bridge published and still holds. A new screen or a new `tool_use_id` makes a new id.

### 3a.4 Answering: `act prompt.answer {terminal, prompt_id, choice}`

`choice` is `{option: i}`, `{picks: [i…]}` (multi-select, per question), or `{other: text}` (at most 2000 characters, with the same text rules as `terminal.send`).

1. **Capability and limits.** Needs `prompt.answer` (§5.1). Rate limit 6 per 10 s. **One answer at a time per terminal**, across all devices, under a bridge lock.
2. **The phone's view is current.** `prompt_id` must be the one the bridge publishes now, else `prompt_changed`.
3. **Transcript check.** The same `tool_use_id` is still pending, and S is still `blocked`.
4. **Screen check.** Run `hc read <t>`, parse the block, recompute the `prompt_id`, and find the cursor's row. Any difference is `prompt_changed`, and nothing is pressed. If the prompt is gone, it is `prompt_gone`: "Already answered on desk-1."
5. **Press with arrows only.** Move from the cursor row to option *i* with `up`/`down`. Digit shortcuts are never used (S16b refuses bare digits as text).
   - **Phase A** presses only the arrow keys (`hc keys`).
   - It then re-reads, and the cursor must be on the expected label in the same `prompt_id`.
   - **Phase B** presses `enter` alone.
   - Multi-select toggles each pick in phase A, then verifies every toggle mark, then confirms.
   - Other: move to the Other row, verify, `hc send --force` the text (it pastes and presses Enter; plain `hc send` is refused while the program is on a dialog, H0), then verify the prompt is gone. `--force` is used here and nowhere else, and only after a fresh `hc read` confirms the same prompt with its own Other field active, in the shape of the H0 recording (decision of the main session, H0 review). Composer sends, Stop and option presses never use it.
6. **Post-check** within 2 s: the prompt block has gone from the screen, or a `tool_result` for that `tool_use_id` has appeared. The result is `ok`. Otherwise it is `unknown_effect`: "Agent 1 may have got your answer. Look before you answer again."

Nothing is ever pressed again by itself. Activity logs "Phone 1 answered a permission prompt in t3: option 1 of 3 (Yes)". The label comes from the screen as the bridge resolved it. The command, the question text and any Other text are never logged (Other by length only).

### 3a.5 Race analysis

| # | race | caught by | residual |
|---|---|---|---|
| R1 | The phone shows a stale card (missed patches, reconnect) | step 2: `prompt_id`/`rev` | none |
| R2 | The prompt changes between the tap and the bridge's read | steps 3 and 4 | none |
| R3 | The desktop answers first | step 4 sees no block: `prompt_gone` | none |
| R4 | Two phones answer at once | per-terminal lock; the first success consumes the `prompt_id` | none |
| R5 | Two identical prompts in a row (same command asked twice) | the `tool_use_id` is part of the id; step 3 needs the same pending `tool_use_id` | small: the transcript is written a little after the screen. Mitigation: the assistant message carrying the `tool_use` is on disk before the dialog shows; verify this in the rig (H0). |
| R6 | **The screen changes between the bridge's read and hc pressing.** `hc keys`/`hc send` wait until nobody has typed at the desk for about 3 s, up to 15 s (S16). | phase A only moves the cursor and is re-verified before `enter`. A wrong arrow press on another prompt moves a cursor and decides nothing. A post-check follows `enter`. | **Recorded residual risk: the window between the phase B read and `enter`.** While hc waits for the desk, it can be up to 15 s. CV7 ships with the two-phase check despite that window, behind `prompt.answer`, which is off by default. It is not blocked on herdr. A request to the herdr owners, H2 (`hc keys --no-wait`, better `--if-screen <sha256>`, which presses under herdr-core's input lock and closes the window), is raised by main. It is a request, not a dependency. |
| R7 | An arrow lands in the text input instead (the prompt closed between the read and phase A) | the phase A re-verify fails, so there is no `enter`: `prompt_changed` | the cursor moved in the input history. That is harmless, and the operator sees "The prompt changed. Look again." |
| R8 | The desk types into the prompt (Tab amend, a partial Other) | the screen check differs (the field holds text) | none |

**Implemented in CV7** (`packages/bridge/src/prompt/`; cards in `chatview:<t>`; PWA `packages/pwa/src/chatview/prompt/`):
- **Parser** (`screen.ts`): the option list nearest the bottom of `hc read` (option 1 searched upward), the nearest full-width `─` rule above it opens the block; header lines between, title = the header's last paragraph; rows numbered in sequence, description lines indented under them, a rule inside the list ("Chat about this"), the unnumbered multi-select "Submit", `[ ]`/`[✔]` boxes; exactly one `❯`, on a row, and none in the header or footer; at most 3 footer lines. Anything else is not a prompt block. Pinned by tests on every H0 screen.
- **Matcher** (`match.ts`): permission = pending `Bash` whose command (whitespace removed) is in the header, title "Do you want to proceed?", an Esc footer; question = pending `AskUserQuestion` with exactly one question whose options are the first rows in order, then the Other row ("Type something." / "Type something"), "Submit" for a multi-select, "Chat about this" below the rule (never offered as an answer); plan = pending `ExitPlanMode`, title ending "Would you like to proceed?"; other = no pending call of those three, all rows numbered and an Esc footer; else `unparsed` (the bottom lines, redacted, read-only). Two pending calls that both match are `unparsed`. AskUserQuestion with several questions is `unparsed` (not recorded). Multi-select cards offer no Other (`other: false`). The card replaces that call's `ask` items and is the last item; it is published only while the host says `waiting` (blocked), re-matched every second.
- **Answer** (`answer.ts`, `other.ts`): as step 1-6 above. The review step after "Submit" (H0) must list exactly the picks with the cursor on "Submit answers" before the second Enter. A press that hc refuses before acting keeps hc's code; a phase A timeout is `busy`; `bad_choice` for a choice that doesn't fit the card. The `--force` argv is built only from a single-use, 3 s confirmation made by `confirmOtherField` from that fresh read.
- **Rig** (`rig/scenarios/prompt-answer.sh`): the real actor against the pinned `claude` and the H0 fake API: permission No, an option, Other (the one `--force`), multi-select picks through the review, plan, a cursor the desk moved, a prompt answered at the desk first (`prompt_gone`, nothing pressed), and the desk-draft wait (see §3a.5 R6).

### 3a.6 Stop

`act agent.stop {terminal}` presses `esc` once.
- It needs `prompt.answer`.
- It is allowed only while S is `working` and no prompt card is open. On a dialog, Esc would cancel it: use the card's No instead.
- There is a 3 s per-terminal cooldown, because a second Esc in Claude Code opens the rewind menu.
- The same two-phase rule applies (re-read, then press). Before pressing, the bridge re-reads the screen and the status. If the agent is no longer working, it is `not_working`: "Agent 1 already stopped." The PWA asks nothing first, because the button is the only control and it is large.
- The result shows as a status row: "Stopped by you · 21:14".

## 4. Plugin timeline items (generic contract)

Plugins stay the source of truth. The bridge only filters rows it already holds from plugin topics by terminal address and passes on plugin-built fields. It never reimplements plugin logic.

**Topic `timeline:<t>`** (needs `view` plus `transcript.read`, §5):

```
TimelineTopic = { terminal, items: TimelineItem[], strip: StripItem[] }
TimelineItem  = { key, plugin, kind, at: iso|null, anchor: {tool_use_id}|null,
                  title, line, href: string|null,        // generic fallback, always present
                  data: unknown }                        // kind-specific, validated per kind
StripItem     = { key, plugin, kind, label, tone: "ok"|"warn"|"bad"|"muted", href|null, data: unknown }
```

- **Placement.** An item with `anchor.tool_use_id` replaces that tool call in the transcript. Otherwise it is placed by `at` among messages (by `timestamp`), else at the end.
- **Rendering.** The screen keeps a registry `kind → component`. A kind the screen doesn't know is drawn from `title`, `line` and `href` as a plain row. So a new plugin adds items without a phone release, and a new component can come later.
- **Actions** are the plugin's existing acts. Nothing new is added on the phone side.

**Kinds in v1:**

| plugin | kind | from | actions |
|---|---|---|---|
| herdr-inbox (must) | `inbox.question` | `inbox` topic `group` rows with `asker.terminal == t`. `data` is the `InboxGroupRow` itself (with `key`, `rev`, `actions`). | inline: tap an option = `inbox.answer` (a lone single-select question); "More options…" opens the Question screen; "Dismiss" = `inbox.dismiss`. Arm delays as in Inbox. Needs `inbox.answer`. |
| herdr-inbox | `inbox.alert` | `alert` rows for `t` | "Seen" = `inbox.ack` |
| herdr-inbox | `inbox.failed` | `failed` rows for `t` | the row's own `retry_label` = `inbox.retry` |
| herdr-inbox | `inbox.answered` | **needs herdr-inbox app-feed to publish recently answered rows** (for example the last 20 per asker, from the last 24 h, with the chosen option labels). Until then, only answers seen by this bridge run are shown, from its own `inbox.answer` results. | none. One collapsed line: "✓ Question Title 119 · Option B" |
| herdr-panorama (should) | strip `panorama.swarm` | the joined root's `agents[]`: counts per status (tiles as on Swarm) and "6 subagents" | link to Swarm (root key), long-press links to Peek of the agent that needs you |
| agent-usage (nice) | strip `usage.account` | the `usage` topic's report: the pane's account label and its window use. The bridge must keep the per-pane account that it now drops. | link to Usage |

Anchor for `ask_operator`: herdr-inbox's question has `created_at`, and the matching `tool_use` sits just before it. In v1 items are placed by time. An exact `tool_use_id` anchor needs the inbox to record it (decision 4, §12).

**Implemented in CV5** (`packages/bridge/src/timeline/`; payloads in bridge-api v1, `timeline:<t>`): question, alert and failed rows, and the panorama strip. I1's `tool_use_id` stays on the bridge (`InboxTopicDriver.toolUseIdOf`), and an item is anchored only when the id is on a herdr-inbox `ask_operator` call in the terminal's own transcript (the open chat view's items, whose `ask` item carries the same `tool_use_id`); one id claimed by two rows anchors neither. Otherwise it is placed by `at`. `inbox.answered` (I1's `answered` rows) and the `usage.account` strip chip (CV6) are not part of CV5. A granted `timeline:<t>` open is in Activity once per subscription, as a chat open is.

## 5. Security

### 5.1 Capability

**Capability `transcript.read`, separate from `view`.**
- **Default:** off for every device, with its own permission. The desktop Remote panel gets a "Chat history" switch ("Lets this phone read agents' conversations, not just the screen."), with no expiry.
- **Why separate.** `view` already shows the terminal's last 200 lines. A transcript is days of history, so a stolen device cookie leaks far more. Keeping it apart lets the operator pair a phone for questions only.
- **What the topics need.** `chatview:<t>` and `timeline:<t>` need `view` + `transcript.read`. Inline inbox actions still need `inbox.answer`. Typing still needs `terminal.input`.

**Capability `prompt.answer`**: one permission for `prompt.answer` and `agent.stop`.
- **Default and expiry.** Off by default. It is turned on from the desktop only and has an expiry, like `terminal.keys`: "Answer prompts: Lets this phone approve commands, answer Claude's questions and stop an agent."
- **Separate from the others.** It is not `terminal.input`, because approving a command is a stronger act than typing a sentence. It is not `terminal.keys`, because the phone never chooses keys: the bridge derives them from a verified screen.
- **Audit.** With the Activity log failing it is refused (`audit_unavailable`), as `terminal.send` is.
- **Its own work only.** Losing it kills only its own press in flight, as S16b does.
- **Migration.** `devices.json` has a strict schema, so this bumps it. As with S16b, there is no downgrade.

### 5.2 What never leaves the bridge

- tool inputs and outputs (commands, file contents, diffs, stdout);
- thinking;
- `toolUseResult`;
- attachments, hook context and system prompts;
- transcript paths, config dir names and session ids. The phone only sees an opaque `chatview:<t>` cursor.

What does leave: user prompt text, assistant text, the AskUserQuestion text and options, tool names, file base names, and counts.

### 5.3 Rendering and limits

- **Markdown.** A whitelist renderer goes to React elements: paragraphs, lists, emphasis, inline code, code blocks, links and tables (as text).
  - No raw HTML. No images, and no remote fetches: the CSP stays `default-src 'self'`.
  - A link is shown with its full URL, and opening it needs a tap plus the system confirmation.
- **Text limits.** Each text block is cut at 16 KB ("Cut here"), and each message at 32 KB.
- **Topic window.** The topic carries the newest 100 items, and a snap stays at or under 512 KB.
- **Older pages:** `GET /api/v1/chatview/<t>?before=<cursor>&n=50`, read-only. It has the same guards as every request (Host, identity, cookie, Origin), needs the same capabilities, and is rate-limited at 20 per 10 s per device.
- **Best-effort redaction** before anything is sent: known secret shapes (`sk-ant-…`, `ghp_…`/`github_pat_…`, `AKIA…`, `xox?-…`, PEM `-----BEGIN … PRIVATE KEY-----`, `Authorization: Bearer …`) become `[hidden]`. It is documented as best-effort, not a guarantee.
- **Audit.** Activity records "Phone 1 opened the chat of t3" once per subscription, and pages by count only. It never records text.
- **No caching on the phone.** The service worker doesn't cache `/api/`, and history lives only in memory while the chat is open.

### 5.4 Threat notes

- A stolen or replayed cookie on the tailnet can read full history while `transcript.read` is on. The mitigations are default off, revoke, pause and Activity.
- A malicious transcript (text the agent copied from the web) could try markdown or HTML injection. It is rendered as text elements only, with no `dangerouslySetInnerHTML`, no images, and no auto-fetched links.
- A wrong session shown is the worst correctness failure. Only panorama's proved binding is used, and an aged or stale feed hides the chat view rather than guessing.
- The reader child processes run as the bridge user, can read every config root, and get no network or tokens. If one is compromised through the SDK supply chain, it has the bridge user's rights, which is the same trust as the bridge itself. The exact pin plus the rig test limit drift.
- Shared projects dirs (symlinked `projects`) mean every reader can see every account's sessions. The binding, not the root, decides which session is shown.

## 6. Fallback (text view with a notice)

| when | notice  |
|---|---|
| harness is not Claude Code | "No chat view for Codex yet" / "This is its terminal, as before." |
| herdr-agent-usage missing or its profile list unreadable (`no_profiles`) | "Chat view needs herdr-agent-usage" / "Showing the terminal." |
| panorama missing or basic mode | "Chat view needs herdr-panorama" / "Showing the terminal." |
| feed aged or stale, or no proved session | "Can't match this agent to its history" / "Showing the terminal." |
| reader failed, or the SDK shape is unexpected | "Can't read this agent's history right now" / "Showing the terminal." |
| `transcript.read` off | "Chat history is off for this phone" / "Turn it on in Remote on desk-1." |

- **Every case is today's text view** (for a Claude agent too, in these fallback cases only): terminal lines, Aa, key bar, Keys menu (S16b). The notice can be closed for the session.
- **Once the chat source is available, the screen moves to the chat view.** It waits for a moment when no Keys sheet and no composer text is open, so nothing the operator is doing is lost. There is no manual switch.

## 7. Protocol additions (bridge-api v1, additive)

- **Topics.**
  - `chatview:<t>` = `{terminal, harness, state: "ok"|"unavailable", reason?, items: ChatItem[], older: boolean, rev, status}`.
    - `status` = `{state: "working"|"blocked"|"idle", since: iso|null}`: the status line (§3) from the host topic; `since` is the last prompt's time while working. It is a field, not an item, so it never shifts the item window.
    - `rev`: random, new whenever the history starts over (another session, a rewritten chain); empty while unavailable.
  - `ChatItem` = `{id, role: "you"|"agent"|"tools"|"ask"|"divider"|"prompt"|"status", at|null}` plus, per role:
    - `you`: `text`; `command?: true` (a chip: `text` is the command alone); `cut?: true` (a 16 KB/32 KB limit cut it: "Cut here").
    - `agent`: `text`, `cut?`.
    - `tools`: `tools: {kind: "shell"|"read"|"edit"|"search"|"subagent"|"other", count, running, failed, names[]}` (`other` also for a mixed run; `names` one line per call, at most 50).
    - `ask`: `ask: {via: "claude"|"inbox", question|null, header|null, multi, options[{label, description|null}]}`, `cut?` (the message's questions were cut to its 32 KB). `via: "inbox"` has no text.
    - `divider`: `divider: "compact"|"day"`.
    - `prompt` (below; published since CV7) and `status` (`status: "stopped"`, CV8, not produced yet).
    - `id` is a message uuid, with `:<n>` for a later item of one message or `day:` for a day divider; opaque.
  - `reason` takes one of the §6 cases (`harness`, `no_panorama`, `no_profiles`, `no_binding`, `reader_failed`); `forbidden` is sent only as `stale` (and 403 on the pages), never in the value. A `chatview:<t>` open Activity can't record is `stale audit_unavailable`.
  - `timeline:<t>` is defined in §4.
- **HTTP.** `GET /api/v1/chatview/<t>?before=<id>&n=<≤50>[&rev=<rev>]` returns `{items, older, rev}`, from the open chat view's items. It needs the `X-Remote-Api: 1` header. Refusals: `409 not_open` (no open chat view for `t`), `409 rev_changed` (another `rev`), `404 unknown_cursor` (an id the bridge doesn't hold), `400` (bad arguments), `401`/`403`/`429`, and `503 audit_unavailable`.
- **Prompt cards** are `ChatItem` role `prompt`: `{prompt_id, rev, kind: "permission"|"question"|"plan"|"other"|"unparsed", title, summary?, questions?: [{text, header, multi, options[{label, description?}], other: boolean}], plan_md?, options: [{label}] (from the screen), screen_lines?: string[] (kind `unparsed`, read-only, redacted), state: "open"|"answered"|"gone"}`.
- **Acts.**
  - `prompt.answer {terminal, prompt_id, rev, choice}`. Results: `ok`, `prompt_changed`, `prompt_gone`, `busy` (desk typing, or another answer running), `forbidden`, `audit_unavailable`, `unknown_effect`.
  - `agent.stop {terminal}`. Results: `ok`, `not_working`, `busy`, `cooldown`, `forbidden`, `audit_unavailable`, `unknown_effect`.
- **Capabilities.** `transcript.read` and `prompt.answer`. In the mod link, the panel gets `device.cap {cap: "transcript.read"}` and `device.cap {cap: "prompt.answer", minutes?}`.
- **Fixtures** under `fixtures/bridge-api/chatview/` and `timeline/`, fake data only.
- The terminal topic `chat:<t>` is unchanged. The text view keeps using it. For Claude the bridge reads it internally, for prompt checks, and the phone does not subscribe to it.

## 8. Slices

| # | Slice | Depends | Tier |
|---|---|---|---|
| CV0 | This spec and the PhoneChatView board (approved 2026-11-13); rows in COPY.md and PLAN §6 | – | D |
| CV1 | Capability `transcript.read`: devices.json schema change (a defaulted field, `v` stays 1, no downgrade), panel switch, Activity | – | SC |
| CV2 | Claude reader: agent-usage profile roots, per-root SDK child, pinned SDK, rig test on fixtures | – | SC |
| CV3 | `chatview:<t>` topic: binding via the panorama join, tail by stat, diff by uuid, limits, redaction, GET pages | CV1, CV2 | SC |
| CV4 | PWA chat view: bubbles, safe markdown, tool rows, jump to latest, older pages, text composer, fallback to the text view | CV3 | N |
| CV5 | `timeline:<t>` plus inline inbox items (question, alert, failed) with existing acts; panorama strip | CV3, S11 | SC (answers) |
| CV6 | agent-usage chip: keep the per-pane account in the usage topic | CV5 | N |
| H0 | Rig: record Claude Code's prompt blocks (permission, AskUserQuestion single and multi, Other, plan) for the pinned version; transcript-before-dialog ordering (R5); multi-select toggle keys | – | N |
| H2 | Request, not ours: `hc keys --no-wait` / `--if-screen <sha256>` in the herdr repo. Main raises it with the herdr owners. Nothing here depends on it. | – | SC there |
| CV7 | `prompt.answer`: capability, prompt parser and matcher (T+S+V), `prompt_id`, two-phase press, post-check, audit; PWA prompt cards and the "prompt changed" refusal. Ships with the two-phase check despite hc's wait window (R6), off by default | CV3, H0 | SC |
| CV8 | `agent.stop` with cooldown; Stop in the composer | CV7 | SC |
| H1 | (optional) log-only Claude plugin hook (`Notification`, `PermissionRequest` without a decision) as a fourth signal | CV7 | SC |
| I1 | (herdr-inbox repo) app-feed: recently answered rows; record the `ask_operator` `tool_use_id` (approved) | – | SC there |
| C1 | Codex through `codex app-server`, `CODEX_HOME` per profile | CV3 | N |

CV1 and CV2 can run in parallel, and so can CV4 and CV5 once CV3 lands.

## 9. Risks

- **The `message` payload is untyped (`unknown`), and `timestamp` isn't in the SDK's type.**
  - Rendering has to be defensive: each block is checked, unknown blocks are dropped, and a message that fails checks becomes nothing.
  - If more than a set share of messages fails, the topic goes `unavailable` and the phone shows the terminal.
  - The rig test pins the shapes seen.
- **SDK cost.** Every call parses the whole file (a 24 MB session takes about 110 ms and 300 MB RSS in the child). It is mitigated by stat-gated calls and a child-process cap. Very long sessions might need a newer SDK with real tail reads.
- **The SDK reads one root per process.** If a later version caches the env at import, the per-child design still holds. Mutating env in-process does not, which is why the design doesn't do it.
- **Profile discovery.** agent-usage's config file format is its own. The bridge reads it only to list `config_dir`s. If agent-usage is missing or the file can't be read, there is no Claude chat view (`no_profiles`) and no fallback scan.
- **Binding gaps.** Sessions panorama can't prove (no hooks, sandboxed `/proc`) have no chat view. That is correct, but the phone may fall back more often than the operator expects.
- **Placing inbox items by time** can be off by one message until I1 adds `tool_use_id`.
- **The answered line needs I1.** Without it, an answer given at the desk doesn't show.
- **Prompt answering reads the screen.** That is scraping, made safe by agreement with the transcript and by verifying before every press, but a Claude Code UI change (glyphs, layout) turns prompts into "can't show" cards until the parser is updated. The rig fixtures (H0) pin the pinned version's blocks. A mismatch never presses; it fails closed.
- **R6 residual race.** hc waits up to 15 s for the desk to go quiet before pressing, so the screen can change between the phase B read and `enter`. CV7 ships with the two-phase check and a post-check anyway, behind `prompt.answer` (off by default, with expiry). The risk is recorded, not removed. H2 (`hc keys --no-wait` or `--if-screen`) is a request main raises with the herdr owners, not a dependency.
- **No terminal for Claude.** With no text view for a supported harness, a prompt the parser can't read can only be read-only on the phone (its screen lines) and answered on the desk (decision 2).

## 10. Alternative considered: Claude Code Remote Control

Remote Control (`claude --rc`) shows a session in the Claude app, but it needs a claude.ai subscription, stores the transcript on Anthropic's servers, gives one session per process, and its multi-config-dir support is undocumented. Rejected by the operator (2026-11-13): it doesn't work with herdr, other harnesses or all of the operator's accounts. Ours stays on the tailnet.

## 11. Wording (rows in COPY.md)

| place | text |
|---|---|
| Working line | Working · 1m 12s / Waiting for you |
| Permission card | PERMISSION · Allow this command? · Shell command · (labels from the screen: Yes / Yes, and don't ask again for: cargo test * / No) · under No: Then tell Agent 1 what to do instead |
| Question card | QUESTION · Other: type your own answer… · Answer · Next: 2 picked · Skip |
| Plan card | PLAN · Ready to start? · Show the whole plan › · (labels from the screen) · under "No, keep planning": Tell Agent 1 what to change |
| Generic card | Agent 1 asks · can't parse: the screen's lines (read-only) · Answer it on desk-1. |
| Refusals | The prompt changed. Look again. / Nothing was pressed. · Already answered on desk-1. · desk-1 is typing. Try again in a moment. · Agent 1 may have got your answer. Look before you answer again. |
| Stop | Stop (aria: Stop Agent 1) · Stopped by you · 21:14 · Agent 1 already stopped. |
| Locked composer | Answer the prompt above first |
| Panel switch (prompts) | Answer prompts: Lets this phone approve commands, answer Claude's questions and stop an agent. |
| Tool rows | Ran 1 shell command · Ran 2 shell commands · Read 3 files · Edited 2 files · Searched 4 times · Ran 3 subagents · Used 2 tools · 1 command failed |
| Older | Loading earlier messages… / Show earlier messages |
| Jump | 4 new ↓ (no new ones: Latest ↓) |
| Empty | No messages yet / New session in ~/code/alpha. What you send appears here. |
| Inline question | More options… · Dismiss |
| Answered | ✓ Question Title 119 · Option B |
| Strip | 6 subagents › · Account 2 · 38% used |
| Composer | Message Agent 1… (text view keeps: Type to the terminal…) |
| Typing off | Read-only here. Typing is off for this phone. |
| No agent-usage | Chat view needs herdr-agent-usage / Showing the terminal. |
| Panel switch | Chat history: Lets this phone read agents' conversations, not just the screen. |

## 12. Decisions (2026-11-13)

1. `transcript.read` is its own capability, off by default, with its own desktop switch (§5.1).
2. A native prompt the phone can't parse shows its screen lines read-only plus "Answer it on desk-1" (§3a.2).
3. Config roots come only from agent-usage's profile list. No `~/.claude*` scan, no `CLAUDE_CONFIG_DIR`, no fallback. Without agent-usage, the text view shows with a notice (§2.2, §6).
4. I1 is approved: herdr-inbox records the `ask_operator` `tool_use_id` and publishes answered rows (§4, §8).
5. `prompt.answer` is one permission, off by default, with expiry. It covers prompt answers and Stop (§5.1).
6. H2 is not a blocker. CV7 ships with the two-phase check despite hc's wait window, behind the off-by-default `prompt.answer`. H2 is a request main raises with the herdr owners (§3a.5 R6, §9).
7. "Yes, and don't ask again" and the auto-mode plan option are pressable from the phone (§3a.1).
8. The AskUserQuestion card answers only on its Answer button (§3a.1).
9. Claude Code agents get the chat view only: no terminal toggle, no key bar, no Keys menu. Codex and unsupported harnesses keep the text view (§1).
