// The per-terminal lock that `prompt.answer` (CV7) and `agent.stop` (CV8) share: one press sequence at a time per
// terminal, across all devices, so a Stop can't land between an answer's phases and an answer can't start inside a
// Stop. While it is held, `terminal.send` and `terminal.keys` into that terminal answer `busy` (app/index.ts).

export class TerminalLocks {
  private readonly held = new Set<string>();

  /** Takes the lock for `terminal`; false when it is held already (the caller answers `busy`). */
  take(terminal: string): boolean {
    if (this.held.has(terminal)) return false;
    this.held.add(terminal);
    return true;
  }

  release(terminal: string): void {
    this.held.delete(terminal);
  }

  has(terminal: string): boolean {
    return this.held.has(terminal);
  }
}
