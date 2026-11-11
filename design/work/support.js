// Local preview shim for <x-dc> files (NOT the design tool's runtime): enough of
// sc-for / sc-if / {{expr}} / onClick / DCLogic.setState to render screenshots.
(function () {
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch) { this.state = Object.assign({}, this.state, patch); window.__dcRender(); }
  }
  window.DCLogic = DCLogic;
  const ev = (expr, scope) => { try { return new Function('__s', 'with(__s){return (' + expr + ')}')(scope); } catch (e) { console.error('expr', expr, e); return undefined; } };
  const one = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
  const sub = (text, scope) => text.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => { const v = ev(e, scope); return v === undefined || v === null ? '' : String(v); });
  function walk(node, scope, out) {
    if (node.nodeType === 3) { out.appendChild(document.createTextNode(sub(node.nodeValue, scope))); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'sc-for') {
      const m = one.exec(node.getAttribute('list') || ''); const list = m ? ev(m[1], scope) || [] : [];
      const as = node.getAttribute('as') || 'item';
      list.forEach((item, i) => { const s = Object.create(scope); s[as] = item; s.$index = i; node.childNodes.forEach(c => walk(c, s, out)); });
      return;
    }
    if (tag === 'sc-if') {
      const m = one.exec(node.getAttribute('value') || ''); if (m && ev(m[1], scope)) node.childNodes.forEach(c => walk(c, scope, out));
      return;
    }
    const el = node.namespaceURI === 'http://www.w3.org/2000/svg' ? document.createElementNS(node.namespaceURI, node.tagName) : document.createElement(node.tagName);
    for (const a of node.attributes) {
      const m = one.exec(a.value);
      if (/^on[A-Z]/.test(a.name) || /^on[a-z]+$/.test(a.name) && m) {
        const fn = m ? ev(m[1], scope) : null; if (typeof fn === 'function') el.addEventListener(a.name.slice(2).toLowerCase(), fn);
        continue;
      }
      const v = m ? ev(m[1], scope) : sub(a.value, scope);
      if (v === undefined || v === null || v === false) continue;
      el.setAttribute(a.name, String(v));
    }
    const kids = tag === 'template' ? node.content.childNodes : node.childNodes;
    kids.forEach(c => walk(c, scope, el));
    out.appendChild(el);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('x-dc'); if (!host) return;
    const helmet = host.querySelector('helmet');
    if (helmet) { [...helmet.childNodes].forEach(n => document.head.appendChild(n.cloneNode(true))); helmet.remove(); }
    const tpl = [...host.childNodes].map(n => n.cloneNode(true));
    const script = document.querySelector('script[data-dc-script]');
    const Component = script ? new Function('DCLogic', script.textContent + '\n;return Component;')(DCLogic) : class extends DCLogic { renderVals() { return {}; } };
    const inst = new Component({});
    const root = document.createElement('div'); root.id = 'dc-root';
    host.replaceWith(root);
    window.__dcRender = () => {
      const vals = inst.renderVals() || {}; const frag = document.createDocumentFragment();
      tpl.forEach(n => walk(n, vals, frag)); root.replaceChildren(frag);
    };
    window.__dcRender();
  });
})();
