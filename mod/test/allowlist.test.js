import { describe, expect, it } from 'vitest';
import { modLink } from '@herdr-remote/protocol';
import { ALLOWLIST, checkRun } from '../herdr-app-remote/allowlist.js';

const CASES = [
  ['agent.focus', { terminal: 't3' }],
  ['agent.focus', { terminal: 'machine-1/t3' }],
  ['agent.focus', {}],
  ['agent.focus', { terminal: 't3', argv: ['sh'] }],
  ['agent.focus', { terminal: '' }],
  ['agent.focus', { terminal: 't 3' }],
  ['agent.focus', { terminal: 'x'.repeat(128) }],
  ['agent.focus', { terminal: 'x'.repeat(129) }],
  ['pane.focus', { pane: 'p1' }],
  ['pane.focus', { terminal: 't1' }],
  ['pane.focus', { pane: 'p1', terminal: 't1' }],
  ['space.select', { id: 'space-1' }],
  ['space.select', { index: 1 }],
  ['space.select', { index: 10000 }],
  ['space.select', { index: 10001 }],
  ['space.select', { index: 0 }],
  ['space.select', { index: 2.5 }],
  ['space.select', { index: '2' }],
  ['tab.select', { id: 'tab-1', index: 1 }],
  ['tab.select', null],
  ['tab.select', []],
  ['tab.select', 'tab-1'],
  ['tab.new', { name: 'Project Alpha' }],
  ['tab.new', { argv: ['sh'] }],
  ['terminal.open', {}],
  ['app.reset', {}],
  ['__proto__', {}],
  ['hasOwnProperty', {}],
  ['', {}],
  [7, {}],
  [null, {}],
];

describe('mod allowlist', () => {
  it('names exactly the protocol allowlist', () => {
    expect([...ALLOWLIST]).toEqual(modLink.RUN_ALLOWLIST);
  });

  it.each(CASES)('agrees with the protocol for %j %j', (name, args) => {
    const proto = modLink.checkRun(name, args);
    const mine = checkRun(name, args);
    expect(mine.ok).toBe(proto.ok);
    if (!proto.ok) expect(mine.error).toBe(proto.error);
  });

  it('refuses objects that are not plain JSON objects', () => {
    expect(checkRun('tab.select', Object.assign(Object.create({ evil: 1 }), { index: 1 }))).toEqual({ ok: false, error: 'bad_args' });
  });
});
