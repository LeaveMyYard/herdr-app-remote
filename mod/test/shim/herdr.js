// A test stand-in for the `herdr` host module (after the herdr-web spike's shim/herdr.mjs).
// Everything reads `world`, which tests fill with fake data; actions are recorded in `world.ran`.

export const world = {
  appHome: '/app-home',
  files: {},
  spaces: [], agents: [], panes: [], terminals: [], focused: null,
  theme: {}, settings: {}, shared: {}, props: {},
  version: '0.0.1',
  ran: [],
  runThrows: null,
  bytes: {}, // path -> Uint8Array, for the fs/promises shim
  execs: [], // [cmd, args, opts] of every exec()
  exec: null, // (cmd, args) => {code, stdout, stderr}; default exit 0
  commands: [], // queued nextCommand() values
};

export function resetWorld() {
  Object.assign(world, {
    appHome: '/app-home', files: {}, spaces: [], agents: [], panes: [], terminals: [], focused: null,
    theme: {}, settings: {}, shared: {}, props: {}, version: '0.0.1', ran: [], runThrows: null,
    bytes: {}, execs: [], exec: null, commands: [],
  });
  commandWaiters.splice(0);
}

export const home = () => '/home-fake';
export const appHome = () => world.appHome;
export const spaces = () => world.spaces;
export const agents = () => world.agents;
export const panes = () => world.panes;
export const terminals = () => world.terminals;
export const focused = () => world.focused;
export const theme = () => world.theme;
export const settings = () => world.settings;
export const props = () => world.props;
export const shared = (key) => world.shared[key];
export const setShared = (key, value) => { world.shared[key] = value; world.ran.push(['setShared', { key, value }]); return null; };
export const run = (name, args) => {
  if (world.runThrows) throw new Error(world.runThrows);
  world.ran.push(['run', { name, args }]);
  return null;
};
export const notify = (n) => { world.ran.push(['notify', n]); return 'n1'; };
export const readTextFile = async (path) => world.files[path] ?? null;
export const updates = () => ({ app: { version: world.version, ready: null, updates: false } });

export const exec = async (cmd, args = [], opts = {}) => {
  world.execs.push([cmd, args, opts]);
  return world.exec ? world.exec(cmd, args, opts) : { code: 0, stdout: '', stderr: '' };
};

const commandWaiters = [];
/** Delivers a key command to the copies waiting in nextCommand(). */
export function sendCommand(c) {
  const w = commandWaiters.shift();
  if (w) w(c);
  else world.commands.push(c);
}
export const nextCommand = () => (world.commands.length ? Promise.resolve(world.commands.shift()) : new Promise((r) => commandWaiters.push(r)));
