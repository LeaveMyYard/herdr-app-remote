# Protocols

- [mod-link v1](mod-link-v1.md): mod to bridge, NDJSON over TCP.
- [bridge-api v1](bridge-api-v1.md): PWA to bridge, HTTP + WebSocket.

The zod schemas in `packages/protocol` are the source of truth. Every example under `fixtures/` is validated against them by `pnpm test`; `fixtures/invalid/` holds examples that must be rejected. Fixtures use fake data only ("Agent 1", "Project Alpha", "Question Title 123").
