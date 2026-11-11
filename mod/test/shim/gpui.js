// Ported from the herdr-web feasibility spike (shim/gpui.mjs), unchanged apart from these two lines.
/* eslint-disable @typescript-eslint/no-unused-vars */
// A Node stand-in for `gpui-kit` and `gpui-base`: every builder call is recorded, so a mod's
// render() produces a plain tree that can be diffed, sent over a wire and drawn as HTML.
//
// A node is { type, id, key, style: [[name, ...args]], hover: [[...]], handlers: {name: fn},
// children: [node | string], props }. Unknown builder names are recorded as style calls, so a mod
// using a method this shim has never seen still renders; html.mjs reports the ones it can't map.

export class View {}

const STRUCTURE = new Set(['child', 'children', 'when', 'when_some', 'when_none', 'map', 'id', 'key', 'hover', 'active', 'group_hover', 'track_focus']);

export const seen = new Map(); // builder name -> count, across every render (for the survey)

function note(name) {
  seen.set(name, (seen.get(name) ?? 0) + 1);
}

// A style-only recorder for `.hover(s => s.bg(c))` and friends.
function styleRecorder(into) {
  const self = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      return (...args) => { into.push([name, ...args]); note(name); return self; };
    },
  });
  return self;
}

export function element(type = 'div', props = {}) {
  const node = { type, id: null, key: null, style: [], hover: [], active: [], handlers: {}, children: [], props };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === '__node') return target;
      if (name === 'then') return undefined; // never look like a promise
      if (typeof name !== 'string') return undefined;
      if (name === 'child') return c => { push(target, c); note(name); return self; };
      if (name === 'children') return cs => { for (const c of cs ?? []) push(target, c); note(name); return self; };
      if (name === 'when') return (cond, then, otherwise) => (cond ? then(self) : otherwise ? otherwise(self) : self) ?? self;
      if (name === 'when_some') return (v, then) => (v != null ? then(self, v) : self) ?? self;
      if (name === 'when_none') return (v, then) => (v == null ? then(self) : self) ?? self;
      if (name === 'map') return f => f(self) ?? self;
      if (name === 'id') return id => { target.id = String(id); note(name); return self; };
      if (name === 'key') return k => { target.key = String(k); return self; };
      if (name === 'hover' || name === 'active' || name === 'group_hover') {
        return (...args) => { const f = args.find(a => typeof a === 'function'); if (f) f(styleRecorder(name === 'active' ? target.active : target.hover)); note(name); return self; };
      }
      if (name === 'track_focus') return h => { target.props.focus = h?.name ?? 'focus'; note(name); return self; };
      return (...args) => {
        note(name);
        const fns = args.filter(a => typeof a === 'function');
        if (name.startsWith('on_') || fns.length > 0) {
          // `on_action(name, fn)`, `on_mouse_down("right", fn)`: keep the leading words as the key.
          const words = args.filter(a => typeof a !== 'function').map(String);
          target.handlers[[name, ...words].join(':')] = fns[fns.length - 1];
          return self;
        }
        target.style.push([name, ...args]);
        return self;
      };
    },
  });
  return self;
}

function push(target, c) {
  if (c === null || c === undefined || c === false) return;
  if (typeof c === 'string' || typeof c === 'number') target.children.push(String(c));
  else if (c.__node) target.children.push(c.__node);
  else if (Array.isArray(c)) for (const x of c) push(target, x);
  else target.children.push(`[unknown child ${typeof c}]`);
}

export const div = () => element('div');
export const h_flex = () => element('div').flex().flex_row().items_center();
export const v_flex = () => element('div').flex().flex_col();
export const svg = path => element('svg', { src: path });
export const image = path => element('img', { src: path });
export const canvas = () => element('canvas');

// gpui-base controls: rendered as typed nodes the HTML side draws as plain widgets.
const control = type => ({ new: (...args) => element(type, { args: args.map(a => (a && typeof a === 'object' && !a.__node ? a.__state ?? '[state]' : a)) }) });
export const Slider = control('Slider');
export const SliderTrack = control('SliderTrack');
export const SliderIndicator = control('SliderIndicator');
export const SliderThumb = control('SliderThumb');
export const Editor = control('Editor');
export const Button = control('Button');
export const Checkbox = control('Checkbox');
export const Switch = control('Switch');
export const Input = control('Input');
export const SliderState = { new: o => ({ __state: { slider: o }, listeners: {}, on(evt, fn) { (this.listeners[evt] ??= []).push(fn); }, value() { return o?.value ?? 0; }, set_value(v) { o.value = v; } }) };
export const EditorState = { new: o => ({ __state: { editor: { language: o?.language, value: o?.value } }, value: () => o?.value ?? '', set_value(v) { o.value = v; }, release() {} }) };
export const InputState = { new: o => ({ __state: { input: o }, value: () => o?.value ?? '', set_value(v) { o.value = v; }, release() {} }) };
export const TextView = { markdown: (id, text) => element('markdown', { text }).id(id) };

export const nodeOf = el => el?.__node ?? el;
