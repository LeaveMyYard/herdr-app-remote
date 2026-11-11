// Rig-only probe mod (never install it in a real app home). It answers, inside an isolated
// herdr-app, the spike's questions about background mods:
//  - does render() run on host data changes, and can it mirror spaces/agents/terminals/focus?
//  - can a mod hold a TCP socket (`net`) to a local sidecar: state out, commands in?
//  - what does exec do with a program that outlives its timeout, and with a daemonized one?
import { View, div } from 'gpui-kit';
import { agents, appHome, exec, focused, panes, run, spaces, terminals } from 'herdr';
import { writeFile } from 'fs/promises';
import net from 'net';

const RIG = '@RIG@';
const PORT = 47123;
const lines = [];

export default class Probe extends View {
  init(_props, cx) {
    this.renders = 0;
    this.sock = null;
    this.name = 'probe';
    cx.spawn(async cx => {
      try {
        this.sock = await net.connect('127.0.0.1', PORT);
        this.say({ hello: this.name, at: Date.now() });
        this.reader(cx);
      } catch (e) {
        this.say({ connect_failed: String(e) });
      }
    });
    // A task with no owner: does it outlive the view (overlay closed, block removed)?
    cx.spawn(async cx => {
      for (let beat = 1; beat <= 40; beat += 1) { await cx.sleep(1000); this.say({ orphan_beat: beat }); }
    }, { owner: null });
    if (this.name !== 'probe') return; // exec tests once, from the docked copy
    cx.spawn(async () => {
      const t0 = Date.now();
      try {
        const r = await exec('sh', [`${RIG}/bin/long.sh`], { timeout: 3000 });
        this.say({ long_exec: 'resolved', code: r.code, ms: Date.now() - t0 });
      } catch (e) {
        this.say({ long_exec: 'rejected', error: String(e), ms: Date.now() - t0 });
      }
      const t1 = Date.now();
      try {
        const r = await exec('sh', ['-c', `setsid ${RIG}/bin/daemon.sh </dev/null >/dev/null 2>&1 &`], { timeout: 5000 });
        this.say({ daemon_exec: 'resolved', code: r.code, ms: Date.now() - t1 });
      } catch (e) {
        this.say({ daemon_exec: 'rejected', error: String(e), ms: Date.now() - t1 });
      }
    });
  }

  async reader(cx) {
    try { await this.readLoop(cx); } catch (e) { this.say({ reader_failed: String(e) }); }
  }

  async readLoop(_cx) {
    let buf = '';
    for (;;) {
      const bytes = await this.sock.read();
      if (bytes === null) { this.say({ socket: 'eof' }); return; }
      buf += typeof TextDecoder === 'function' ? new TextDecoder().decode(bytes) : String.fromCharCode(...bytes);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const c = JSON.parse(line);
          run(c.run, c.args ?? {});
          this.say({ ran: c.run });
        } catch (e) {
          this.say({ command_failed: String(e) });
        }
      }
    }
  }

  say(obj) {
    const line = JSON.stringify({ from: this.name, ...obj });
    lines.push(line);
    if (this.sock) this.sock.write(`${line}\n`).catch(() => {});
    writeFile(`${appHome()}/data/${this.name}.log`, `${lines.join('\n')}\n`).catch(() => {});
  }

  render(_cx) {
    this.renders += 1;
    this.say({
      render: this.renders,
      spaces: spaces().map(s => ({ name: s.name, tabs: s.tabs.length, active: s.active })),
      agents: agents().length,
      terminals: terminals().map(t => t.address ?? t.id),
      panes: panes().length,
      focused: focused(),
    });
    return div().child(`probe ${this.renders}`);
  }

  async close() {
    this.say({ closed: true });
  }
}
