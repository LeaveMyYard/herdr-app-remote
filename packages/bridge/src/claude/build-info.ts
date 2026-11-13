// The Claude reader child's sha256, injected into bridge.mjs at build time by scripts/bundle.mjs (esbuild
// `define`), so the bridge runs only the reader built with it (docs/chatview.md §2.2, CV3). In the unbundled
// build (tsc's dist/, tests, rigs) it is null, and whoever starts the pool passes the hash explicitly.
declare const __HERDR_READER_SHA256__: string | undefined;

export const BUILT_READER_SHA256: string | null = typeof __HERDR_READER_SHA256__ === "string" ? __HERDR_READER_SHA256__ : null;
