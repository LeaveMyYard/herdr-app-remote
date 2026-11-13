# Third-party code in the bridge

The bridge ships as two self-contained files built by `scripts/bundle.mjs` from the operator's own checkout: `dist/bridge.mjs` and `dist/claude-reader.mjs` (installed to `data/herdr-app-remote/bin/`). No release artifact with these files is published; `scripts/app-install` copies the locally built files.

| Package | Version | In | Licence |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.312, exact | `claude-reader.mjs` | Anthropic proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." The notice is kept at the top of the bundle. |
| `smol-toml` | 1.9.1, exact | `bridge.mjs` (once the chat view topic uses the reader) | BSD-3-Clause |
| `ws` | ^8.22.2 | `bridge.mjs` | MIT |
| `zod` | ^3.25.76 | `bridge.mjs` | MIT |
| `uqr` | ^0.1.3 | `bridge.mjs` | MIT |
| `es-module-lexer` | 1.7.0, exact | `bridge.mjs` | MIT |

## Claude Agent SDK

The chat view's reader child (`src/claude/reader-child.ts`, docs/chatview.md §2.2) imports only `getSessionMessages` and `getSessionInfo`. It never calls `query()`, so it never starts Claude Code, spends tokens or writes anything; the child runs under Node's permission model, which also denies writes and child processes.

- **Pinned** to 0.3.312 (published 2026-10-27, 17 days before the slice started). Bumping it is a reviewed change: the rig test (`rig/test/claude-reader.test.ts`) compares the SDK's raw output for the fixture transcripts in `fixtures/claude` byte for byte, so a shape change fails CI.
- **No native binary.** The SDK's optional `claude-agent-sdk-<platform>` packages (about 281 MB, the Claude Code executable) are listed in `ignoredOptionalDependencies` in `pnpm-workspace.yaml`, the equivalent of `--omit=optional`. Reading history doesn't need them.
- **No peers.** Its peers (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod` 4) are marked optional through `packageExtensions`, so they are not installed: `sdk.mjs` imports only Node built-ins.
