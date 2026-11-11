/** Probe strings and minimum versions for the plugins the bridge reuses (PLAN section 3). */

/** First line of `herdr-inbox app --help`; the `app` verbs and feed are protocol v1. */
export const INBOX_PROBE_PREFIX = "herdr-inbox app v";
export const INBOX_PROTOCOL = 1;

/** `usagebar collect --format v1` prints `{"version": 1, ...}`. */
export const USAGE_FORMAT = 1;

/** Panorama's feed is `v == 2`, validated by its own `contract.js`. */
export const PANORAMA_FEED_VERSION = 2;
/** The feed is stale after this long (PLAN S8: a 15 s staleness rule, same as contract.js `aged`). */
export const FEED_STALE_MS = 15_000;
/** `readTextFile` reads at most this much, so a feed is never bigger (app-feed-v1). */
export const FEED_MAX_BYTES = 1_048_576;

/** Oldest `hc` the bridge supports (`hc --version`). */
export const MIN_HC_VERSION = "0.1.0";

export const PROBE_TIMEOUT_MS = 10_000;

/** The plugin files the bridge loads, relative to the app home. Each is hash-checked against its install receipt. */
export const PANORAMA_RECEIPT = "data/panorama/install.json";
export const PANORAMA_CONTRACT = "mods/panorama/contract.js";
export const PANORAMA_FEED = "data/panorama/feed.json";
export const INBOX_RECEIPT = "data/herdr-inbox/install.json";
export const INBOX_FEED_JS = "mods/herdr-inbox/feed.js";
export const INBOX_COMMANDS_JS = "mods/herdr-inbox/commands.js";
export const INBOX_FEED = "data/herdr-inbox/feed.json";
/** The inbox's pure wording (delivery lines, severities); import-free, so it loads hash-pinned like the other two. */
export const INBOX_WORDS_JS = "mods/herdr-inbox/words.js";
