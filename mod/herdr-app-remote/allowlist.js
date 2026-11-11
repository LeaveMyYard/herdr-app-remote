// The commands the bridge may ask this mod to run, checked here again (the bridge checks first).
// Must equal RUN_ARGS in packages/protocol/src/mod-link.ts; a parity test keeps them in step.
// Plain JS with no imports: it runs inside herdr-app, where zod is not available.

const ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const isId = (v) => typeof v === 'string' && ID.test(v);
const isIndex = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10000;

function plain(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    && Object.getPrototypeOf(args) === Object.prototype;
}

/** Exactly one key, `key`, whose value passes `ok`. */
const only = (key, ok) => (args) => {
  const keys = Object.keys(args);
  return keys.length === 1 && keys[0] === key && ok(args[key]);
};
const either = (...alts) => (args) => alts.some((alt) => alt(args));

const RULES = Object.freeze({
  'agent.focus': only('terminal', isId),
  'pane.focus': either(only('pane', isId), only('terminal', isId)),
  'space.select': either(only('id', isId), only('index', isIndex)),
  'tab.select': either(only('id', isId), only('index', isIndex)),
});

export const ALLOWLIST = Object.freeze(Object.keys(RULES).sort());

/** `{ok: true}` or `{ok: false, error: "not_allowed" | "bad_args"}`. */
export function checkRun(name, args) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(RULES, name)) {
    return { ok: false, error: 'not_allowed' };
  }
  if (!plain(args) || !RULES[name](args)) return { ok: false, error: 'bad_args' };
  return { ok: true };
}
