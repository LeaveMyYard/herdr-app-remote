# herdr-app-remote

Phone access to herdr-app over Tailscale: a bridge, a PWA and a mod. See `docs/PLAN.md` for the plan and `docs/protocol/` for the wire contracts. Design boards are in `design/`.

```
pnpm install
pnpm verify   # typecheck, lint, build, test
pnpm typecheck && pnpm lint
```

Requires Node >= 22 and pnpm 10.
