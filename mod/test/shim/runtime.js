// Runs one mod View the way herdr-app does (after the herdr-web spike's shim/runtime.mjs):
// init(props, cx) once, render(cx) after cx.notify(), async close(cx) at the end.
// `cx.sleep` records every requested delay and sleeps `ms * scale`, so backoff can be asserted
// without waiting for it.
import { nodeOf } from './gpui.js';
import { world } from './herdr.js';

export class Mounted {
  constructor(ViewClass, { props = {}, scale = 1 } = {}) {
    this.scale = scale;
    this.sleeps = [];
    this.handles = new Set();
    this.renders = 0;
    this.stopped = false;
    world.props = props;
    this.view = new ViewClass();
    this.view.init(props, this.cx());
    this.render();
  }

  cx() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const guard = () => { if (self.stopped) throw new Error('cx used after close'); };
    return {
      notify: () => { guard(); self.render(); },
      spawn: (task) => {
        guard();
        Promise.resolve().then(() => task(self.cx())).catch((e) => { if (!self.stopped) self.error = e; });
        return { cancel() {}, is_done: () => false };
      },
      timer: {
        every: (ms, fn) => {
          guard();
          const h = setInterval(() => { if (!self.stopped) fn(self.cx()); }, ms * self.scale);
          self.handles.add(h);
          return { cancel: () => clearInterval(h), is_done: () => false };
        },
        after: (ms, fn) => {
          guard();
          const h = setTimeout(() => { if (!self.stopped) fn(self.cx()); }, ms * self.scale);
          self.handles.add(h);
          return { cancel: () => clearTimeout(h), is_done: () => false };
        },
      },
      sleep: (ms = 0) => {
        guard();
        self.sleeps.push(ms);
        return new Promise((r) => { const h = setTimeout(r, ms * self.scale); self.handles.add(h); });
      },
    };
  }

  render() {
    this.renders += 1;
    this.tree = nodeOf(this.view.render(this.cx()));
    return this.tree;
  }

  async close() {
    await this.view.close?.(this.cx());
    this.stopped = true;
    for (const h of this.handles) { clearInterval(h); clearTimeout(h); }
  }
}

export const settle = async (ms = 20) => new Promise((r) => setTimeout(r, ms));
