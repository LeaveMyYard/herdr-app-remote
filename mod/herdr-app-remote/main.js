// herdr-app-remote: one mod, two copies.
// - role "link": a 1 px block in an always-shown column. Mirrors host state to the
//   bridge and runs the allowlisted commands it sends back.
// - role "panel": the Remote panel in panel-body (panel.js: Status, Devices, Plugins, Activity). It links
//   as copy "panel", never sends state, draws the PanelView the bridge pushes, and asks the bridge for the
//   desktop-only operations (approve, revoke, capabilities, pause, pairing code) with `panel_act`.
// - Both linked copies take the `open` command (keys.json `herdr-app-remote.open`, from the
//   installer's --key): show the panel column and select the Remote child. Local only: nothing the
//   bridge sends can reach it.
// - The link copy starts the bridge when it finds none (install.js Launcher); both copies connect
//   only to a bridge that runs the installed bundle and whose pid is alive (trustRuntime).
// - any other props (mod.open, tab.new {mod}, a hand-made block): inert, never connects, so a stray
//   copy can't fight the real link for its slot.
import { View, div } from 'gpui-kit';
import { agents, focused, nextCommand, panes, props, run, settings, shared, spaces, terminals, theme, updates } from 'herdr';
import { buildHost } from './host.js';
import { Launcher, trustRuntime } from './install.js';
import { Link } from './link.js';
import { ACT_ERRORS, TABS, renderPanel, sanitize } from './panel.js';

/** Layout ids the derived layouts use (packages/protocol/src/install.ts). */
export const PANEL_COLUMN = 'panel';
export const PANEL_STACK = 'panel-body';
export const PANEL_CHILD = 'remote';

/** Recheck the snapshot this often without a render, so an expired panorama lease shows. */
const RECHECK_MS = 5000;
/** The panel redraws this often so "Away · 3h" and the pairing countdown stay current. */
const PANEL_TICK_MS = 1000;
const COPIED_MS = 1500;

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
      onPanel: (view, cx) => {
        const v = sanitize(view);
        if (v) this.view = v;
        cx.notify();
      },
      onStatus: (up, cx) => {
        this.connected = up;
        cx.notify();
      },
    });
    if (this.role === 'panel') this.initPanel(cx);
    cx.spawn(async (cx) => this.commands(cx));
    if (this.role === 'link') {
      this.offer();
      cx.timer.every(RECHECK_MS, () => this.offer());
    }
    this.link.start(cx);
  }

  initPanel(cx) {
    this.view = null;
    this.connected = false;
    // Layout props may pick the tab shown first (the rig's side-by-side shots use it).
    const first = props()?.tab;
    this.tab = TABS.some(([id]) => id === first) ? first : 'status';
    this.expanded = null; // device id whose access switches are open
    this.expiryFor = null; // device id being asked how long terminal input stays on
    this.copied = false;
    this.error = null;
    // Redraw only while a countdown is on screen or a minute boundary may have passed.
    cx.timer.every(PANEL_TICK_MS, (cx) => {
      if (this.view?.pairing || Date.now() % 60000 < PANEL_TICK_MS) cx.notify();
    });
    this.on = {
      setTab: (cx, id) => { this.tab = id; this.error = null; cx.notify(); },
      expand: (cx, id) => { this.expanded = id; this.expiryFor = null; cx.notify(); },
      askExpiry: (cx, id) => { this.expiryFor = id; cx.notify(); },
      copy: (cx, text) => {
        cx.write_to_clipboard(text);
        this.copied = true;
        cx.timer.after(COPIED_MS, (cx) => { this.copied = false; cx.notify(); });
        cx.notify();
      },
      act: (cx, kind, args) => this.act(cx, kind, args),
      // Turning terminal input on asks for an expiry first; every other switch flips at once.
      toggleCap: (cx, d, cap) => {
        if (cap === 'terminal.input' && !d.caps[cap]) return this.on.askExpiry(cx, d.id);
        return this.act(cx, 'device.cap', { id: d.id, cap, on: !d.caps[cap] });
      },
      setTerminalInput: (cx, d, minutes) => {
        this.expiryFor = null;
        return this.act(cx, 'device.cap', { id: d.id, cap: 'terminal.input', on: true, ...(minutes ? { minutes } : {}) });
      },
    };
  }

  /** Sends one desktop-only operation to the bridge; the new view arrives as a `panel` message. */
  act(cx, kind, args) {
    this.error = null;
    cx.spawn(async (cx) => {
      const r = await this.link.act(cx, kind, args);
      this.error = r.ok ? null : (ACT_ERRORS[r.code] ?? `That didn't work (${r.code}).`);
      cx.notify();
    });
    cx.notify();
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
    if (this.role === 'panel') {
      return renderPanel({
        view: this.view, tab: this.tab, expanded: this.expanded, expiryFor: this.expiryFor, copied: this.copied,
        error: this.error, connected: this.connected, now: Date.now(), theme: theme(),
      }, this.on);
    }
    return div().id('remote-inert').size_full();
  }

  async close() {
    this.closed = true;
    this.link?.close();
  }
}
