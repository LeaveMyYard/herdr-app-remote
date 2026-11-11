# Third-party assets in the PWA

All assets are bundled into the build and served from our own origin; nothing is fetched from a third party at runtime.

| Asset | Source | Licence |
|---|---|---|
| Inter (variable, opsz + wght, latin subset) | `@fontsource-variable/inter`, from https://github.com/rsms/inter | SIL Open Font License 1.1 (OFL-1.1) |
| JetBrains Mono 400 and 500 (latin subset) | `@fontsource/jetbrains-mono`, from https://github.com/JetBrains/JetBrainsMono | SIL Open Font License 1.1 (OFL-1.1) |
| Claude and Codex harness glyphs (`src/assets/claude.svg`, `codex.svg`) | Lobe Icons (https://github.com/lobehub/lobe-icons), as shipped in `design/icons/` | MIT. The MIT notice is the upstream one; the logos themselves are trademarks of their owners. |

The OFL permits bundling and redistribution with software; the font licence texts are in `licenses/`.

The app mark (`src/assets/remote.svg`, `design/icons/remote.svg`) and the icons in `public/icons/` are original to this project: a phone with signal arcs, drawn for herdr-app-remote, with PNGs exported with `rsvg-convert`. Herdr's own logo is not shipped.
