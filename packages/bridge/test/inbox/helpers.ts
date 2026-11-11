import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { put, sha, tmp } from "../plugins/helpers.js";

export const NOW = 1_800_000_000_000;

/**
 * Fake `feed.js`, `commands.js` and `words.js`: the same exports as the real plugin files and written here
 * (no real plugin code is copied). All three are import-free, as the real ones are.
 */
export const FAKE_FEED_JS = `
const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
export function parseFeed(text) {
  if (text === null) return { problem: 'missing', errors: [] };
  let f;
  try { f = JSON.parse(text); } catch { return { problem: 'unreadable', errors: [] }; }
  if (!isObject(f) || f.v !== 1) return { problem: 'unsupported', errors: [] };
  const errors = Array.isArray(f.errors) ? f.errors.filter(e => typeof e === 'string') : [];
  if (f.ok === false) return { problem: 'not-ok', errors };
  if (f.ok !== true || !isObject(f.omitted) || !Array.isArray(f.entries)) return { problem: 'unreadable', errors };
  return { feed: { ...f, errors } };
}
export function isStale(g, now) { return typeof g !== 'number' || !Number.isFinite(g) || g > now || now - g > 15; }
export const leftOut = f => f.omitted.groups + f.omitted.failed + f.omitted.alerts + f.omitted.remote + f.omitted.questions;
export function incompleteness(f) {
  if (f.errors.length === 0 && leftOut(f) === 0) return null;
  const o = f.omitted;
  const say = (n, one, many) => (n > 0 ? [n + ' ' + (n === 1 ? one : many)] : []);
  const counts = [...say(o.questions, 'question', 'questions'), ...say(o.groups, 'group', 'groups'), ...say(o.failed, 'undelivered answer', 'undelivered answers'), ...say(o.alerts, 'alert', 'alerts'), ...say(o.remote, 'remote row', 'remote rows')];
  return { counts, errors: f.errors, ids: o.question_ids, unlisted: Math.max(o.questions - o.question_ids.length, 0) };
}
`;

export const FAKE_COMMANDS_JS = `
export const showArgs = qid => ['app', 'show', '--question', String(qid), '--json'];
export function readResult(result, verb, entry) {
  if (result === null) return { kind: 'unknown', why: 'it could not be started' };
  if (result.code !== 0 && result.code !== 1) return { kind: 'unknown', why: 'it exited ' + result.code };
  let v;
  try { v = JSON.parse(result.stdout); } catch { return { kind: 'unknown', why: 'not a result' }; }
  if (v === null || typeof v !== 'object' || v.v !== 1 || v.verb !== verb) return { kind: 'unknown', why: 'not a result' };
  if (result.code === 0 && v.ok === true) return { kind: 'shown', row: v.row };
  return { kind: 'refused', code: v.code, closed: v.closed ?? null, message: v.message ?? '' };
}
`;

export const FAKE_WORDS_JS = `
export function deliveryWords(row) {
  const d = row.delivery;
  switch (d.state) {
    case 'pending': return { warn: !d.auto_retry, line: 'It waits for the agent.' };
    case 'failed': return { warn: true, line: 'The last attempt failed.' };
    case 'unattempted': return { warn: !d.auto_retry, line: 'Not delivered yet: nobody has tried.' };
    case 'agent_gone': return { warn: true, line: 'The agent is gone.' };
    case 'claimed': return { warn: true, line: 'A process stopped while sending this.' };
    default: return { warn: true, line: d.reason ?? 'Its state is not known here.' };
  }
}
const KNOWN = new Set(['unattempted', 'claimed', 'pending', 'agent_gone', 'failed']);
export const knownDelivery = row => KNOWN.has(row.delivery.state);
export function retryLabel(row) {
  const now = row.asker.host === 'herdr-tui' && row.delivery.state === 'pending' && (row.delivery.wait === 'busy' || row.delivery.wait === 'busy_idle');
  return now ? 'Send now' : 'Retry delivery';
}
const SEV = new Set(['urgent', 'warning', 'info']);
export const severity = w => (SEV.has(w) ? w : 'warning');
export const alertKind = w => (w === 'blocked' ? 'blocked' : 'agent');
`;

const MODS = "mods/herdr-inbox";

export interface Home {
  home: string;
  /** The fake plugin root holding `scripts/launch`. */
  root: string;
  /** The launcher's call log, one line per call (the arguments after `launch`). */
  calls: () => string[];
  /** Sets what `app show --question <q> --json` prints (exit 0), or removes it. */
  show: (qid: number, row: unknown | null) => void;
  setHelp: (text: string, code?: number) => void;
  setEnsureCode: (code: number) => void;
  writeFeed: (feed: unknown | string | null) => void;
}

/** An app home with the (fake) inbox install receipt, plugin files and feed, plus a fake plugin root and launcher. */
export function inboxHome(
  opts: { feed?: unknown | string | null; files?: Partial<Record<"feed" | "commands" | "words", string>>; pinned?: Partial<Record<"feed" | "commands" | "words", string>>; receipt?: boolean; root?: boolean } = {},
): Home {
  const home = tmp("s10-home-");
  const root = tmp("s10-root-");
  const files = { feed: FAKE_FEED_JS, commands: FAKE_COMMANDS_JS, words: FAKE_WORDS_JS, ...opts.files };
  const names = { feed: "feed.js", commands: "commands.js", words: "words.js" } as const;
  const receipt: Record<string, string> = {};
  for (const k of ["feed", "commands", "words"] as const) {
    put(home, `${MODS}/${names[k]}`, files[k]);
    receipt[`${MODS}/${names[k]}`] = opts.pinned?.[k] ?? sha(files[k]);
  }
  if (opts.receipt !== false) {
    put(home, "data/herdr-inbox/install.json", JSON.stringify({ v: 1, plugin_root: opts.root === false ? "/nonexistent/root" : root, plugin_moves: false, claude_config: null, dirs: [], files: receipt }));
  }
  put(root, "herdr-plugin.toml", "name = 'fake'\n");
  put(root, "help.out", "herdr-inbox app v1\nusage: fake\n");
  put(
    root,
    "scripts/launch",
    `#!/bin/sh
D=$(dirname "$0")/..
shift
echo "$*" >> "$D/calls.log"
case "$1 $2" in
  "app --help") cat "$D/help.out"; exit $(cat "$D/help.code" 2>/dev/null || echo 0);;
  "app show")
    f="$D/show-$4.json"
    if [ -f "$f" ]; then cat "$f"; exit 0; fi
    echo '{"v":1,"ok":false,"verb":"show","entry":"group:0","code":"stale","message":"closed","closed":"answered"}'; exit 1;;
  "app-feed --ensure") exit $(cat "$D/ensure.code" 2>/dev/null || echo 0);;
esac
exit 2
`,
  );
  chmodSync(join(root, "scripts/launch"), 0o755);
  const h: Home = {
    home,
    root,
    calls: () => {
      try {
        return readFileSync(join(root, "calls.log"), "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    show: (qid, row) => {
      const p = join(root, `show-${qid}.json`);
      if (row === null) rmSync(p, { force: true });
      else writeFileSync(p, JSON.stringify({ v: 1, ok: true, verb: "show", entry: (row as { key: string }).key, row }));
    },
    setHelp: (text, code = 0) => {
      writeFileSync(join(root, "help.out"), text);
      writeFileSync(join(root, "help.code"), String(code));
    },
    setEnsureCode: (code) => writeFileSync(join(root, "ensure.code"), String(code)),
    writeFeed: (feed) => {
      const p = join(home, "data/herdr-inbox/feed.json");
      if (feed === null) rmSync(p, { force: true });
      else put(home, "data/herdr-inbox/feed.json", typeof feed === "string" ? feed : JSON.stringify(feed));
    },
  };
  if (opts.feed !== null) h.writeFeed(opts.feed === undefined ? feedDoc() : opts.feed);
  return h;
}

// ---- fake feed data ("Agent 1", "Project Alpha", ...) ----

export const asker = (over: Record<string, unknown> = {}) => ({ host: "herdr-core", pane: null, terminal: "t1", tab_label: null, cwd: "/work/project-alpha", ...over });

export const question = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  header: "Choice",
  question: `Question Title ${id}`,
  options: [
    { label: "Option A", description: "The first", preview: null },
    { label: "Option B", description: null, preview: null },
  ],
  multi_select: false,
  context: null,
  asked_by: "agent-1",
  draft: null,
  cut: false,
  ...over,
});

export const group = (id: number, over: Record<string, unknown> = {}) => ({
  key: `group:${id}`,
  kind: "group",
  token: `tok-group-${id}`,
  actions: ["answer", "draft", "dismiss"],
  group: id,
  title: `Question Title ${id}`,
  created_at: "2026-01-01T00:00:00+00:00",
  asker: asker(),
  questions: [question(id)],
  ...over,
});

export const alertEntry = (id: number, over: Record<string, unknown> = {}) => ({
  key: `alert:${id}`,
  kind: "alert",
  token: `tok-alert-${id}`,
  actions: ["ack"],
  id,
  alert_kind: "agent",
  severity: "warning",
  title: `Alert Title ${id}`,
  message: null,
  asked_by: "agent-3",
  created_at: "2026-01-01T00:00:00+00:00",
  asker: asker({ cwd: null }),
  ...over,
});

export const failedEntry = (qid: number, over: Record<string, unknown> = {}) => ({
  key: `failed:${qid}`,
  kind: "failed",
  token: `tok-failed-${qid}`,
  actions: ["retry", "stop-showing"],
  question_id: qid,
  group: qid,
  header: null,
  question: `Question Title ${qid}`,
  asked_by: "agent-2",
  answer: "Option B",
  answered_at: "2026-01-01T00:00:00+00:00",
  retries: 0,
  cut: false,
  asker: asker({ host: "herdr-tui", pane: "p1", terminal: null }),
  delivery: { state: "pending", reason: null, wait: "busy", attempts: 0, pending_since: "2026-01-01T00:00:00+00:00", auto_retry: true },
  ...over,
});

export function feedDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    generated_at: NOW / 1000 - 2,
    ok: true,
    errors: [],
    omitted: { groups: 0, questions: 0, failed: 0, alerts: 0, remote: 0, question_ids: [] },
    new_since: { question_id: 130, alert_id: 40 },
    entries: [alertEntry(456), group(123), group(127)],
    ...over,
  };
}
