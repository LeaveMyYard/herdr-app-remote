# herdr-app-remote

Phone access to herdr-app over Tailscale: a bridge, a PWA and a mod. See `docs/PLAN.md` for the plan and `docs/protocol/` for the wire contracts. Design boards are in `design/`.

```
pnpm install
pnpm verify   # typecheck, lint, build, test
pnpm typecheck && pnpm lint
```

Requires Node >= 22 and pnpm 10.

## Install into herdr-app

```
pnpm install && pnpm build
scripts/app-install install --app-home ~/.config/herdr-app [--key ctrl-alt-r] [--node /abs/path/to/node]
scripts/app-install uninstall --app-home ~/.config/herdr-app [--checker /abs/path/to/herdr-app]
```

Install adds the mod, the bridge bundle and two layouts, `herdr-remote` (the shipped `main` with the Remote blocks) and, when panorama's layout matches panorama's own install record, `panorama-remote`. It selects no layout and changes no setting; switch to one of them to start the bridge. `--key` binds a key to open the Remote panel in those two layouts only, which makes `keys.json` your own file from then on (herdr-app stops adding new default shortcuts to an edited one). Uninstall removes only unchanged files of ours, and refuses while the window shows a layout that uses the mod. The two layouts are copies taken at install time: after a herdr-app or panorama upgrade, run `install` again to refresh them.
