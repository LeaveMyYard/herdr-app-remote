Terminal screens of Claude Code's native prompts, one folder per Claude Code version (the pin is the folder name and
`manifest.json`'s `claudeCode`). Not protocol fixtures: the schema walk in packages/protocol/test/fixtures.test.ts
skips this folder; the real-data scan does not.

Recorded (not hand-written) by `rig/scenarios/claude-prompts.sh`: the real `claude` binary in the rig's own hc terminal
(200 x 120), a private HOME, a made-up API key and a scripted fake Anthropic API on the rig's loopback
(`rig/fake-anthropic.mjs`). No credentials, no network. Content is fake ("Agent 1", "Project Alpha", "Question Title 123").
Each `.txt` is `hc read` output with trailing blanks stripped; the plan file's path is replaced by `~/CONFIG/plans/plan-1.md`.

The `stop-*` screens and the manifest's `stop` section (CV8: what Esc does while working, idle, twice, and on a prompt)
are recorded by `rig/scenarios/agent-stop.sh` (part 1 of `agent-stop-harness.mjs`, files in the rig's `rec-stop/`); a
re-record with `claude-prompts.sh` rewrites `manifest.json`, so keep or re-add that section and its `files` rows.

`manifest.json` says what each file is, the multi-select and Other key findings, and the R5 result (the assistant message
holding the `tool_use` was on disk before the dialog showed, 4 of 4). CV7's parser tests read these files. To move the
pin: install the new Claude Code, change `PINNED_CLAUDE_VERSION` in the scenario, run it, copy `rec-claude/*` to a new
version folder, and review the diff of the screens.

Parser notes (all visible in the screens): permission option 3 has an inline suffix ("· auto mode handles these prompts for you"); the plan's option 3 is "Tell Claude what to change" (a feedback input), not "No, keep planning"; Other is "Type something." in single-select and "Type something" in multi; "Chat about this" sits below a rule; the multi-select "Submit" row is unnumbered and Enter on it opens a review step needing a second Enter; the cursor `❯` must be found only inside the block below the last full-width rule (the echoed user message also starts with `❯`). Multi-select plus Other is not recorded.
