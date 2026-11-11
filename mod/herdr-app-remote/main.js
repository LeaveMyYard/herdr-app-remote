// herdr-app-remote: one mod, two copies.
// - role "link": a 1 px block in an always-shown column. Mirrors host state to the
//   bridge and runs the allowlisted commands it sends back.
// - role "panel": the Remote panel in panel-body (its views land in S13); it links as copy
//   "panel" and never sends state.
// - any other props (mod.open, tab.new {mod}, a hand-made block): inert, never connects, so a stray
//   copy can't fight the real link for its slot.
import { View, div } from 'gpui-kit';
import { agents, focused, panes, settings, shared, spaces, terminals, updates } from 'herdr';
import { buildHost } from './host.js';
import { Link } from './link.js';

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

export default class Remote extends View {
  init(props, cx) {
    const role = props?.role;
    this.role = role === 'link' || role === 'panel' ? role : null;
    if (!this.role) return;
    this.link = new Link({ copy: this.role, hello: () => ({ layout: layoutName(), app: { version: appVersion() } }) });
    if (this.role === 'link') {
      this.offer();
      cx.timer.every(RECHECK_MS, () => this.offer());
    }
    this.link.start(cx);
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
    this.link?.close();
  }
}
