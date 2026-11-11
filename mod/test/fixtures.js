// Fake herdr-app data, shaped like herdr.d.ts (spaces/agents/panes) and `hc ls --json` (terminals).
export const NOW = 1_800_000_000_000;

export function fakeWorld() {
  return {
    spaces: [
      { id: 'space-1', index: 1, name: 'Project Alpha', active: true, tabs: [{ id: 'tab-1', index: 1, name: '1', active: true }] },
      { id: 'space-2', index: 2, name: 'Project Beta', active: false, tabs: [{ id: 'tab-2', index: 1, name: '1', active: true }] },
    ],
    agents: [
      { address: 't1', pane: 'p1', space: 'space-1', tab: 'tab-1', status: 'working', app: 'claude-code', title: 'Agent 1', program: { key: 'claude', name: 'Claude Code' } },
      { address: 't2', pane: 'p2', space: 'space-2', tab: 'tab-2', status: 'blocked', app: null, title: '', program: { key: 'codex', name: 'Codex' } },
    ],
    terminals: [
      { address: 't1', title: 'Agent 1', name: null, cols: 120, rows: 40, state: 'live' },
      { address: 't2', title: '', name: 'Agent 2', cols: 100, rows: 30, state: 'live' },
      { address: 't9', title: 'orphan', cols: 80, rows: 24, state: 'live' },
    ],
    panes: [
      { pane: 'p1', terminal: 't1', tab: 'tab-1', title: 'Agent 1' },
      { pane: 'p2', terminal: 't2', tab: 'tab-2', title: 'Agent 2' },
      { pane: 'p3', terminal: null, mod: 'files', tab: 'tab-1', title: 'files' },
    ],
    focused: { space: 'space-1', tab: 'tab-1', pane: 'p1', terminal: 't1', shown: null, agent: 't1', cwd: null },
    settings: { theme: 'Theme 1', dark: true },
    shared: { layout: 'herdr-remote', 'panorama.feed.owner': { v: 1, token: 'lease-token-1', role: 'sidebar', seen_at: NOW - 1000 } },
  };
}
