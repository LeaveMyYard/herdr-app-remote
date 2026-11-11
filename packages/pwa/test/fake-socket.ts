import type { SocketLike } from "../src/bridge/client";

/** A WebSocket stand-in the test drives by hand. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  protocol = "";
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // ---- driven by the test ----
  open() {
    this.readyState = 1;
    this.protocol = this.protocols[0] ?? "";
    this.onopen?.({});
  }
  recv(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  ofType(t: string) {
    return this.sent.filter((m) => m.type === t);
  }
}

export class FakeTarget {
  visibilityState: DocumentVisibilityState = "visible";
  private l = new Map<string, Set<() => void>>();
  addEventListener(t: string, f: () => void) {
    (this.l.get(t) ?? this.l.set(t, new Set()).get(t)!).add(f);
  }
  removeEventListener(t: string, f: () => void) {
    this.l.get(t)?.delete(f);
  }
  fire(t: string) {
    for (const f of this.l.get(t) ?? []) f();
  }
}

