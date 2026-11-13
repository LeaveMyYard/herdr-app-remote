import { bridgeApi } from "@herdr-remote/protocol";

export type OlderResult =
  | { ok: true; page: bridgeApi.ChatviewPage }
  /** Another history now: the topic is bringing the new one. */
  | { ok: false; code: "rev_changed" | "forbidden" | "failed" };

/** `GET /api/v1/chatview/<t>?before=<id>&n=50&rev=<rev>`: the page of items just before `before`. */
export async function fetchOlder(terminal: string, before: string, rev: string): Promise<OlderResult> {
  try {
    const q = new URLSearchParams({ before, n: String(bridgeApi.CHATVIEW_PAGE_MAX), rev });
    const r = await fetch(`/api/v1/chatview/${encodeURIComponent(terminal)}?${q.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Remote-Api": "1" },
    });
    if (r.status === 403) return { ok: false, code: "forbidden" };
    // Another history (409 rev_changed), no open chat view (409 not_open) or a cursor the bridge no longer holds (404
    // unknown_cursor): none succeeds by asking again; the topic brings the current window, so wait for it.
    if (r.status === 409 || r.status === 404) return { ok: false, code: "rev_changed" };
    if (r.status !== 200) return { ok: false, code: "failed" };
    const page = bridgeApi.ChatviewPage.safeParse(await r.json());
    return page.success ? { ok: true, page: page.data } : { ok: false, code: "failed" };
  } catch {
    return { ok: false, code: "failed" };
  }
}
