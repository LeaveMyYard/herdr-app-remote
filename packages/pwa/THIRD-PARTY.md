# Third-party assets in the PWA

All assets are bundled into the build and served from our own origin; nothing is fetched from a third party at runtime.

| Asset | Source | Licence |
|---|---|---|
| Inter (variable, opsz + wght, latin subset) | `@fontsource-variable/inter`, from https://github.com/rsms/inter | SIL Open Font License 1.1 (OFL-1.1) |
| JetBrains Mono 400 and 500 (latin subset) | `@fontsource/jetbrains-mono`, from https://github.com/JetBrains/JetBrainsMono | SIL Open Font License 1.1 (OFL-1.1) |
| Claude and Codex harness glyphs (`src/assets/claude.svg`, `codex.svg`) | Lobe Icons, as shipped in `design/icons/` | MIT |
| Herdr mark (`src/assets/herdr.png` and the app icons derived from it) | `design/icons/herdr.png` from the herdr-app mods | Same terms as herdr-app |

The OFL permits bundling and redistribution with software; the licence texts ship in each npm package (`LICENSE`).
