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

The `askq-*` and `askr-*` screens and the manifest's `multiQuestion` section (CV9: AskUserQuestion with several
questions, Claude Code's tabbed UI: the tab line, the keys between tabs, Enter on an option, ticks and Next/Submit, Other
per question, the review, Esc) are recorded by `rig/scenarios/claude-multiq.sh` (`claude-multiq-harness.mjs`, files in the
rig's `rec-multiq/`, its findings in `rec-multiq/multiq.json`); keep or re-add that section and its `files` rows too.

`manifest.json` says what each file is, the multi-select and Other key findings, and the R5 result (the assistant message
holding the `tool_use` was on disk before the dialog showed, 4 of 4). CV7's parser tests read these files. To move the
pin: install the new Claude Code, change `PINNED_CLAUDE_VERSION` in the scenario, run it, copy `rec-claude/*` to a new
version folder, and review the diff of the screens.

Parser notes (all visible in the screens): permission option 3 has an inline suffix ("· auto mode handles these prompts for you"); the plan's option 3 is "Tell Claude what to change" (a feedback input), not "No, keep planning"; Other is "Type something." in single-select and "Type something" in multi; "Chat about this" sits below a rule; the multi-select "Submit" row is unnumbered and Enter on it opens a review step needing a second Enter; the cursor `❯` must be found only inside the block below the last full-width rule (the echoed user message also starts with `❯`). With several questions a multi-select ends in "Next" ("Submit" on the last question), and the tab line does not show which tab is active. Multi-select plus Other was recorded in CV9 (typing ticks the box, Enter toggles it) and is still not offered.

The pin moved from 2.1.323 to 2.1.325 in CV9: all three scenarios re-recorded. The H0 and CV8 screens differ in the version banner, the spinner and timing lines, and on the idle screens (`stop-idle*`) the status line `◐ medium · /effort` is gone and the footer no longer ends in `· ← for agents`. No parser or check uses either.
