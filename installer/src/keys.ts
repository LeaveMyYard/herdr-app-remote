// The optional `--key` binding in keys.json. It goes only in the `layout:<name>` sections of our own
// derived layouts, so it can't change what the key does anywhere else, and it is refused when the key
// is already bound where it would matter there (`global`, `terminal`, or those sections).
//
// herdr-app treats any edit of keys.json as the person's own file from then on (an untouched one
// gets new default shortcuts on upgrade; an edited one doesn't). That is why the binding is opt-in.
import { install } from "@herdr-remote/protocol";

type Sections = Record<string, Record<string, unknown>>;

export const sectionFor = (layoutPath: string): string => `layout:${layoutPath.replace(/^layouts\//, "").replace(/\.json$/, "")}`;

function parse(text: string): Sections {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("keys.json is not valid JSON; nothing changed");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("keys.json is not an object; nothing changed");
  for (const [name, section] of Object.entries(v)) {
    if (section === null || typeof section !== "object" || Array.isArray(section)) throw new Error(`keys.json section ${name} is not an object; nothing changed`);
  }
  return v as Sections;
}

const render = (s: Sections): string => JSON.stringify(s, null, 2) + "\n";

const boundIn = (section: Record<string, unknown> | undefined, key: string): string | undefined =>
  section ? Object.keys(section).find((k) => k.toLowerCase() === key.toLowerCase()) : undefined;

/**
 * keys.json with our binding added, after removing `owned` (the one the record names, if any).
 * Throws when the key is taken.
 */
export function addBinding(text: string, binding: install.KeyBinding, owned: install.KeyBinding | null): string {
  const keys = owned ? parse(removeBinding(text, owned) ?? text) : parse(text);
  for (const name of ["global", "terminal", ...binding.sections]) {
    const k = boundIn(keys[name], binding.key);
    if (k !== undefined) throw new Error(`${binding.key} is already bound in keys.json (${name}: ${JSON.stringify(keys[name]![k])}); nothing changed. Pick another --key`);
  }
  for (const name of binding.sections) keys[name] = { ...(keys[name] ?? {}), [binding.key]: binding.action };
  return render(keys);
}

/**
 * keys.json without our binding; null when there is nothing of ours to remove. An entry whose action
 * is no longer ours is the person's and stays. A section left empty is removed: it is named after
 * one of our layouts.
 */
export function removeBinding(text: string, binding: install.KeyBinding): string | null {
  const keys = parse(text);
  let changed = false;
  for (const name of binding.sections) {
    const section = keys[name];
    const k = boundIn(section, binding.key);
    if (!section || k === undefined || section[k] !== install.OPEN_COMMAND) continue;
    delete section[k];
    if (Object.keys(section).length === 0) delete keys[name];
    changed = true;
  }
  return changed ? render(keys) : null;
}
