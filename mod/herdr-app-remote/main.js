// herdr-app-remote: one mod, two copies.
// - role "link": a 1 px block in an always-shown column. Mirrors host state to the
//   bridge and runs the allowlisted commands it sends back.
// - role "panel": the Remote panel in panel-body (its views land in S13); it links as copy
//   "panel" and never sends state.
// - Both linked copies take the `open` command (keys.json `herdr-app-remote.open`, from the
//   installer's --key): show the panel column and select the Remote child. Local only: nothing the
//   bridge sends can reach it.
// - The link copy starts the bridge when it finds none (install.js Launcher); both copies connect
//   only to a bridge that runs the installed bundle and whose pid is alive (trustRuntime).
// - any other props (mod.open, tab.new {mod}, a hand-made block): inert, never connects, so a stray
//   copy can't fight the real link for its slot.
import { View, div } from 'gpui-kit';
import { agents, focused, nextCommand, panes, props, run, settings, shared, spaces, terminals, updates } from 'herdr';
import { buildHost } from './host.js';
import { Launcher, trustRuntime } from './install.js';
import { Link } from './link.js';

/** Layout ids the derived layouts use (packages/protocol/src/install.ts). */
export const PANEL_COLUMN = 'panel';
export const PANEL_STACK = 'panel-body';
export const PANEL_CHILD = 'remote';

/** Recheck the snapshot this often without a render, so an expired panorama lease shows. */
const RECHECK_MS = 5000;

function layoutName() {
  const name = shared('layout');
  return typeof name === 'string' && name ? name : 'unknown';
}

function appVersion() {
  try {
    const v = updates()?.app?.version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function snapshot(now = Date.now()) {
  return buildHost({
    spaces: spaces(),
    agents: agents(),
    terminals: terminals(),
    panes: panes(),
    focused: focused(),
    settings: settings(),
    layoutName: shared('layout'),
    owner: shared('panorama.feed.owner'),
    now,
  });
}

/** Shows the panel column with the Remote child on top. Both are no-ops when already so. */
export function openPanel(runFn = run) {
  try {
    runFn('layout.show', { id: PANEL_COLUMN });
    runFn('layout.select', { stack: PANEL_STACK, child: PANEL_CHILD });
  } catch (e) {
    console.warn('herdr-app-remote: open failed', String(e));
  }
}

export default class Remote extends View {
  init(_props, cx) {
    // The app passes nothing to init (rig run, herdr-app 2026-11): the layout's props come from props().
    const role = props()?.role;
    this.role = role === 'link' || role === 'panel' ? role : null;
    if (!this.role) return;
    this.launcher = this.role === 'link' ? new Launcher() : null;
    this.link = new Link({
      copy: this.role,
      hello: () => ({ layout: layoutName(), app: { version: appVersion() } }),
      trust: (rt) => trustRuntime(rt),
      unreachable: () => this.launcher?.maybe(),
    });
    cx.spawn(async (cx) => this.commands(cx));
    if (this.role === 'link') {
      this.offer();
      cx.timer.every(RECHECK_MS, () => this.offer());
    }
    this.link.start(cx);
  }

  async commands(cx) {
    while (!this.closed) {
      const c = await nextCommand();
      if (this.closed) return;
      if (c === 'open') openPanel();
      cx.notify();
    }
  }

  offer() {
    if (!this.link) return;
    try {
      this.link.offer(snapshot());
    } catch (e) {
      console.warn('herdr-app-remote: snapshot failed', String(e));
    }
  }

  render() {
    if (this.role === 'link') {
      this.offer();
      return div().id('remote-link').size_full();
    }
    if (this.role === 'panel') return div().id('remote-panel').size_full().p(12).text_size(13).child('Remote');
    return div().id('remote-inert').size_full();
  }

  async close() {
    this.closed = true;
    this.link?.close();
  }
}
