// The timeline inside the chat view (CV5b; docs/chatview.md §4): `placeTimeline` puts each item among the chat
// items, and each is drawn as a `TimelineRow` in the list's own item box. Acts go through the `act` given, which in
// the live app is the inbox's own path (LiveApp's `inboxAct`, as the Question screen uses).
import { useMemo } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import type { ActFn } from "../inbox/act";
import { placeTimeline, type Placement } from "./model";
import { TimelineRow } from "./Timeline";

export interface InlineTimeline {
  items: readonly bridgeApi.TimelineItem[];
  /** Sends an inbox `act`; without one nothing is sent. */
  act?: ActFn | undefined;
}

/** Where each item goes among `items`; null without a timeline. */
export function usePlaced(items: readonly bridgeApi.ChatItem[], timeline: InlineTimeline | undefined): Placement | null {
  const list = timeline?.items;
  return useMemo(() => (list && list.length > 0 ? placeTimeline(items, list) : null), [items, list]);
}

/** Timeline rows, each in the chat list's item box. `now` is the chat view's clock (ms). */
export function TimelineRows({ items, act, now }: { items: readonly bridgeApi.TimelineItem[]; act?: ActFn | undefined; now: number }) {
  return (
    <>
      {items.map((t) => (
        <div key={`tl:${t.key}`} className="cv-item" data-timeline={t.kind}>
          <TimelineRow item={t} act={act} now={Math.floor(now / 1000)} />
        </div>
      ))}
    </>
  );
}
