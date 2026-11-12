// Builds the mod-link `HostState` (packages/protocol/src/host.ts) from what herdr-app reports.
// Pure: every input is passed in, so tests can feed fake data. Anything that would not match the
// schema (a missing id, a terminal with no known space) is left out rather than sent malformed.

const OWNER_TTL_MS = 15000; // panorama's lease TTL (feed-client.js)
const OWNER_ROLES = ['sidebar', 'consumer'];

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const posInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/** herdr-app's Status to the protocol's AgentState. */
export function agentState(status) {
  switch (status) {
    case 'working': return 'working';
    case 'blocked': return 'waiting';
    case 'done': return 'done';
    case 'idle': return 'idle';
    default: return 'unknown';
  }
}

/**
 * The role of a live panorama feed owner, or null. Only the role leaves the app: the lease token
 * stays inside it. A lease older than the TTL counts as no owner.
 */
export function feedOwner(lease, now) {
  if (!lease || typeof lease !== 'object') return null;
  if (lease.v !== 1 || !str(lease.token) || !OWNER_ROLES.includes(lease.role)) return null;
  const seen = lease.seen_at;
  if (typeof seen !== 'number' || !Number.isFinite(seen) || seen > now || now - seen >= OWNER_TTL_MS) return null;
  return lease.role;
}

/**
 * @param {object} src
 * @param {any[]} src.spaces    spaces()
 * @param {any[]} src.agents    agents()
 * @param {any[]} src.terminals terminals()
 * @param {any[]} src.panes     panes()
 * @param {any} src.focused     focused()
 * @param {any} src.settings    settings()
 * @param {unknown} src.layoutName shared("layout")
 * @param {unknown} src.owner   shared("panorama.feed.owner")
 * @param {number} src.now      Date.now()
 */
export function buildHost(src) {
  const spacesIn = Array.isArray(src.spaces) ? src.spaces : [];
  const tabSpace = new Map();
  const spaces = [];
  for (const s of spacesIn) {
    const id = str(s?.id);
    if (!id) continue;
    spaces.push({ id, name: typeof s.name === 'string' ? s.name : '', focused: s.active === true });
    for (const t of Array.isArray(s.tabs) ? s.tabs : []) if (str(t?.id)) tabSpace.set(t.id, id);
  }
  const known = new Set(spaces.map((s) => s.id));

  const panes = [];
  const terminalSpace = new Map();
  for (const p of Array.isArray(src.panes) ? src.panes : []) {
    const id = str(p?.pane);
    const space = tabSpace.get(p?.tab);
    if (!id || !space) continue;
    const terminal = str(p.terminal);
    const pane = { id, space_id: space, kind: terminal ? 'terminal' : 'mod' };
    if (terminal) {
      pane.terminal_id = terminal;
      if (!terminalSpace.has(terminal)) terminalSpace.set(terminal, space);
    }
    panes.push(pane);
  }

  const agents = [];
  for (const a of Array.isArray(src.agents) ? src.agents : []) {
    const id = str(a?.address);
    const space = str(a?.space);
    if (!id || !space || !known.has(space)) continue;
    if (!terminalSpace.has(id)) terminalSpace.set(id, space);
    const program = str(a.program?.key);
    agents.push({
      id,
      name: str(a.title) ?? str(a.program?.name) ?? id,
      harness: str(a.app) ?? str(a.program?.key) ?? 'agent',
      state: agentState(a.status),
      space_id: space,
      terminal_id: id,
      ...(program ? { program } : {}),
    });
  }

  const terminals = [];
  for (const t of Array.isArray(src.terminals) ? src.terminals : []) {
    const id = str(t?.address);
    const space = id ? terminalSpace.get(id) : null;
    const cols = posInt(t?.cols);
    const rows = posInt(t?.rows);
    if (!id || !space || !cols || !rows) continue;
    terminals.push({ id, title: str(t.title) ?? str(t.name) ?? '', space_id: space, cols, rows });
  }

  const f = src.focused && typeof src.focused === 'object' ? src.focused : {};
  const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  return {
    spaces,
    agents,
    terminals,
    panes,
    focused: { space_id: str(f.space), pane_id: str(f.pane), agent_id: str(f.agent) },
    theme: { name: str(settings.theme) ?? 'default', mode: settings.dark === false ? 'light' : 'dark' },
    layout_name: str(src.layoutName) ?? 'unknown',
    shared: { 'panorama.feed.owner': feedOwner(src.owner, src.now) },
  };
}
