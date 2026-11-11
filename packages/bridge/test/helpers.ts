import { readFileSync } from "node:fs";
import { bridgeApi } from "@herdr-remote/protocol";
import type { HubClient } from "../src/hub.js";
import { Hub } from "../src/hub.js";
import type { Json } from "../src/patch.js";

export class FakeClient implements HubClient {
  readonly got: bridgeApi.ServerMessage[] = [];
  closed: { code: number; reason: string } | undefined;
  send(msg: bridgeApi.ServerMessage): void {
    this.got.push(msg);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  ofType<T extends bridgeApi.ServerMessage["type"]>(t: T): Extract<bridgeApi.ServerMessage, { type: T }>[] {
    return this.got.filter((m) => m.type === t) as Extract<bridgeApi.ServerMessage, { type: T }>[];
  }
}

export function newHub(opts: Partial<ConstructorParameters<typeof Hub>[0]> = {}): Hub {
  return new Hub({ bridgeVersion: "0.0.0-test", epoch: "epoch-1", ...opts });
}

export async function join(hub: Hub, resume?: { epoch: string; seqs: Record<string, number> }) {
  const client = new FakeClient();
  const conn = hub.connect(client);
  const send = (m: unknown) => hub.handleRaw(conn, JSON.stringify(m));
  await send(resume ? { type: "hello", api: 1, resume } : { type: "hello", api: 1 });
  return { client, conn, send };
}

export const HOST = (n: number): Json => ({ n, items: [1, 2, 3], nested: { a: "x" } });

export const fixture = (name: string): Json =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/host/${name}.json`, import.meta.url), "utf8")) as Json;
