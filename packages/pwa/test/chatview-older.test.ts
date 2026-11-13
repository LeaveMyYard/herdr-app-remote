import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOlder } from "../src/bridge/chatview";

afterEach(() => vi.unstubAllGlobals());
const reply = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("fetchOlder", () => {
  it("asks for the page before an item at its rev, with the API header", async () => {
    const f = reply(200, { items: [], older: false, rev: "r1" });
    vi.stubGlobal("fetch", f);
    expect(await fetchOlder("t1", "m:1", "r1")).toEqual({ ok: true, page: { items: [], older: false, rev: "r1" } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/chatview/t1?before=m%3A1&n=50&rev=r1");
    expect(init.headers).toEqual({ "X-Remote-Api": "1" });
  });
  it("maps the refusals", async () => {
    vi.stubGlobal("fetch", reply(403));
    expect(await fetchOlder("t1", "a", "r")).toEqual({ ok: false, code: "forbidden" });
    vi.stubGlobal("fetch", reply(409));
    expect(await fetchOlder("t1", "a", "r")).toEqual({ ok: false, code: "rev_changed" });
    vi.stubGlobal("fetch", reply(404));
    expect(await fetchOlder("t1", "a", "r")).toEqual({ ok: false, code: "failed" });
    vi.stubGlobal("fetch", reply(200, { nope: 1 }));
    expect(await fetchOlder("t1", "a", "r")).toEqual({ ok: false, code: "failed" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchOlder("t1", "a", "r")).toEqual({ ok: false, code: "failed" });
  });
});
