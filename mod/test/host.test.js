import { describe, expect, it } from 'vitest';
import { HostState } from '@herdr-remote/protocol';
import { agentState, buildHost, feedOwner } from '../herdr-app-remote/host.js';
import { NOW, fakeWorld } from './fixtures.js';

const build = (w = fakeWorld(), now = NOW) => buildHost({
  spaces: w.spaces, agents: w.agents, terminals: w.terminals, panes: w.panes, focused: w.focused,
  settings: w.settings, layoutName: w.shared.layout, owner: w.shared['panorama.feed.owner'], now,
});

describe('buildHost', () => {
  it('maps herdr-app data to a valid HostState', () => {
    const host = build();
    expect(HostState.safeParse(host).success).toBe(true);
    expect(host).toEqual({
      spaces: [
        { id: 'space-1', name: 'Project Alpha', focused: true },
        { id: 'space-2', name: 'Project Beta', focused: false },
      ],
      agents: [
        { id: 't1', name: 'Agent 1', harness: 'claude-code', state: 'working', space_id: 'space-1', terminal_id: 't1', program: 'claude' },
        { id: 't2', name: 'Codex', harness: 'codex', state: 'waiting', space_id: 'space-2', terminal_id: 't2', program: 'codex' },
      ],
      terminals: [
        { id: 't1', title: 'Agent 1', space_id: 'space-1', cols: 120, rows: 40 },
        { id: 't2', title: 'Agent 2', space_id: 'space-2', cols: 100, rows: 30 },
      ],
      panes: [
        { id: 'p1', space_id: 'space-1', kind: 'terminal', terminal_id: 't1' },
        { id: 'p2', space_id: 'space-2', kind: 'terminal', terminal_id: 't2' },
        { id: 'p3', space_id: 'space-1', kind: 'mod' },
      ],
      focused: { space_id: 'space-1', pane_id: 'p1', agent_id: 't1' },
      theme: { name: 'Theme 1', mode: 'dark' },
      layout_name: 'herdr-remote',
      shared: { 'panorama.feed.owner': 'sidebar' },
    });
  });

  it('never carries the panorama lease token', () => {
    expect(JSON.stringify(build())).not.toContain('lease-token-1');
  });

  it('stays valid for empty or garbage input', () => {
    const empty = buildHost({ now: NOW });
    expect(HostState.safeParse(empty).success).toBe(true);
    expect(empty.layout_name).toBe('unknown');
    const junk = buildHost({
      spaces: [null, { id: '' }, { id: 's', tabs: 'x' }], agents: [{}, null], terminals: [{ address: 't1', cols: 0, rows: 3 }],
      panes: [{ pane: 'p', tab: 'missing' }], focused: 'x', settings: null, layoutName: 5, owner: 'x', now: NOW,
    });
    expect(HostState.safeParse(junk).success).toBe(true);
  });

  it('maps a light theme and null focus', () => {
    const w = fakeWorld();
    w.settings = { dark: false };
    w.focused = null;
    const host = build(w);
    expect(host.theme).toEqual({ name: 'default', mode: 'light' });
    expect(host.focused).toEqual({ space_id: null, pane_id: null, agent_id: null });
  });

  it.each([['working', 'working'], ['blocked', 'waiting'], ['done', 'done'], ['idle', 'idle'], [null, 'unknown'], ['x', 'unknown']])(
    'agent status %s -> %s', (s, want) => expect(agentState(s)).toBe(want));
});

describe('feedOwner', () => {
  const lease = { v: 1, token: 'lease-token-1', role: 'consumer', seen_at: NOW - 14_999 };
  it('reports the role of a live lease', () => expect(feedOwner(lease, NOW)).toBe('consumer'));
  it('treats an expired, future or malformed lease as no owner', () => {
    expect(feedOwner({ ...lease, seen_at: NOW - 15_000 }, NOW)).toBeNull();
    expect(feedOwner({ ...lease, seen_at: NOW + 1 }, NOW)).toBeNull();
    expect(feedOwner({ ...lease, role: 'viewer' }, NOW)).toBeNull();
    expect(feedOwner({ ...lease, token: '' }, NOW)).toBeNull();
    expect(feedOwner({ ...lease, v: 2 }, NOW)).toBeNull();
    expect(feedOwner(null, NOW)).toBeNull();
  });
});
