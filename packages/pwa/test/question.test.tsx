import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { act as flush, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { bridgeApi } from "@herdr-remote/protocol";
import { DEMO_NOW, demoHost, inboxScenario } from "../src/inbox-fixtures";
import { ClosedRows, type ActFn, type ActResult } from "../src/inbox/act";
import { ROW_ARM_MS, VIEW_ARM_MS } from "../src/inbox/arm";
import { Inbox } from "../src/screens/Inbox";
import { Question } from "../src/screens/Question";

type Group = Extract<bridgeApi.InboxRow, { kind: "group" }>;

let clock = 0;
beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  window.location.hash = "";
});
afterEach(() => vi.restoreAllMocks());

/** Lets the arm delay pass. */
const wait = (ms = VIEW_ARM_MS) => {
  clock += ms;
};

function fakeAct(results: ActResult[] = [{ ok: true }]) {
  const calls: { kind: string; args: Record<string, unknown> }[] = [];
  const fn: ActFn = (kind, args) => {
    calls.push({ kind, args });
    return Promise.resolve(results.shift() ?? { ok: true });
  };
  return { calls, fn };
}

const typical = () => inboxScenario("typical").topic;
const groupOf = (topic: bridgeApi.InboxTopic, key: string) => topic.entries.find((r) => r.key === key) as Group;
const lone = () => groupOf(typical(), "group:127");
const big = () => groupOf(typical(), "group:123");

function question(row: Group, tab: number | "submit", a = fakeAct(), closed = new ClosedRows()) {
  const r = render(<Question row={row} tab={tab} host={demoHost} now={DEMO_NOW} act={a.fn} closed={closed} />);
  return { ...r, a, closed };
}

const tap = async (el: HTMLElement) => {
  await flush(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
};

describe("Question: a lone question", () => {
  it("ignores taps until the inbox's arm delay has passed", async () => {
    const { a } = question(lone(), 127);
    await tap(screen.getByRole("button", { name: /Option B/ }));
    expect(screen.getByRole("button", { name: /Option B/ })).toHaveAttribute("aria-pressed", "false");
    wait();
    await tap(screen.getByRole("button", { name: /Option B/ }));
    expect(screen.getByRole("button", { name: /Option B/ })).toHaveAttribute("aria-pressed", "true");
    expect(a.calls).toEqual([]);
  });

  it("sends option indices and the note, bound to the row's rev, and leaves a placeholder on the list", async () => {
    const a = fakeAct([{ ok: true, closed: "answered", message: "Sending Q127 in the background." }]);
    const { closed } = question(lone(), 127, a);
    wait();
    await tap(screen.getByRole("button", { name: /Option B/ }));
    fireEvent.change(screen.getByLabelText("Note for the agent"), { target: { value: " Note 1 " } });
    await tap(screen.getByRole("button", { name: "Send ⏎" }));
    expect(a.calls).toEqual([{ kind: "inbox.answer", args: { key: "group:127", rev: "rev-group-127", question: 127, detail: { choices: [1], notes: { "1": "Note 1" }, text: null } } }]);
    expect(window.location.hash).toBe("#/inbox");
    expect(closed.get("group:127")).toMatchObject({ title: "Question Title 127", reason: "answered" });
    expect(closed.notice()).toBe("Sending Q127 in the background.");
  });

  it("sends a typed answer as text only", async () => {
    const { a } = question(lone(), 127);
    wait();
    await tap(screen.getByRole("button", { name: /Something else/ }));
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Text 1" } });
    await tap(screen.getByRole("button", { name: "Send ⏎" }));
    expect(a.calls[0]?.args.detail).toEqual({ choices: [], notes: {}, text: "Text 1" });
  });

  it("sends nothing with nothing picked", async () => {
    const { a } = question(lone(), 127);
    wait();
    await tap(screen.getByRole("button", { name: "Send ⏎" }));
    expect(a.calls).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("Pick an option or type an answer.");
  });

  it("shows a refusal and stays, without trying again", async () => {
    const a = fakeAct([{ ok: false, code: "stale", message: "This group changed, look again. Nothing was sent." }]);
    question(lone(), 127, a);
    wait();
    await tap(screen.getByRole("button", { name: /Option A/ }));
    await tap(screen.getByRole("button", { name: "Send ⏎" }));
    expect(screen.getByRole("alert")).toHaveTextContent("This group changed, look again. Nothing was sent.");
    expect(a.calls).toHaveLength(1);
    expect(window.location.hash).toBe("");
  });

  it("an unknown effect goes back to the list saying so, and is never repeated", async () => {
    const a = fakeAct([{ ok: false, code: "unknown_effect", unknown_effect: true }]);
    const { closed } = question(lone(), 127, a);
    wait();
    await tap(screen.getByRole("button", { name: /Option A/ }));
    await tap(screen.getByRole("button", { name: "Send ⏎" }));
    expect(a.calls).toHaveLength(1);
    expect(window.location.hash).toBe("#/inbox");
    expect(closed.notice()).toMatch(/unknown/);
  });

  it("re-arms when the row changes under the finger", async () => {
    const { a, rerender, closed } = question(lone(), 127);
    wait();
    rerender(<Question row={{ ...lone(), rev: "rev-new" }} tab={127} host={demoHost} now={DEMO_NOW} act={a.fn} closed={closed} />);
    await tap(screen.getByRole("button", { name: /Option A/ }));
    expect(screen.getByRole("button", { name: /Option A/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("dismisses only on a second tap", async () => {
    const { a } = question(lone(), 127);
    wait();
    await tap(screen.getByRole("button", { name: "Dismiss" }));
    expect(a.calls).toEqual([]);
    await tap(screen.getByRole("button", { name: /tap again/ }));
    expect(a.calls).toEqual([{ kind: "inbox.dismiss", args: { key: "group:127", rev: "rev-group-127" } }]);
  });
});

describe("Question: a group", () => {
  it("stores a draft on Next and moves on; an unchanged answer moves on without a draft", async () => {
    const a = fakeAct();
    question(big(), 123, a);
    wait();
    expect(screen.getByRole("tab", { name: "Multi" })).toHaveAttribute("data-state", "drafted");
    await tap(screen.getByRole("button", { name: /Option C/ }));
    await tap(screen.getByRole("button", { name: "Next ⏎" }));
    expect(a.calls).toEqual([{ kind: "inbox.draft", args: { key: "group:123", rev: "rev-group-123", question: 123, detail: { choices: [2], notes: {}, text: null } } }]);
    expect(window.location.hash).toBe("#/inbox/q/group%3A123/124");
  });

  it("keeps a stored multi-select draft and only re-sends it when it changed", async () => {
    const a = fakeAct();
    question(big(), 124, a);
    wait();
    expect(screen.getByRole("button", { name: /Option X/ })).toHaveAttribute("aria-pressed", "true");
    await tap(screen.getByRole("button", { name: "Next ⏎" }));
    expect(a.calls).toEqual([]);
    expect(window.location.hash).toBe("#/inbox/q/group%3A123/125");
  });

  it("clears a draft that was emptied", async () => {
    const a = fakeAct();
    question(big(), 124, a);
    wait();
    await tap(screen.getByRole("button", { name: /Option X/ }));
    await tap(screen.getByRole("button", { name: /Option Z/ }));
    await tap(screen.getByRole("button", { name: "Next ⏎" }));
    expect(a.calls[0]).toEqual({ kind: "inbox.draft", args: { key: "group:123", rev: "rev-group-123", question: 124, clear: true } });
  });

  it("reviews the stored drafts and submits the questions that have one", async () => {
    const row = groupOf(inboxScenario("review").topic, "group:123");
    const a = fakeAct([{ ok: true, closed: "answered" }]);
    const { closed } = question(row, "submit", a);
    expect(screen.getByText("Sends 2 of 3 · Free text stays open")).toBeInTheDocument();
    const items = screen.getAllByRole("link").filter((l) => l.className.includes("qn-item"));
    expect(items.map((l) => l.textContent)).toEqual(["Q123 · SingleOption A›", "Q124 · MultiOption X, Option Z›", "Q125 · Free textNo answer yet: it stays open›"]);
    await tap(screen.getByRole("button", { name: /Submit answers/ }));
    expect(a.calls).toEqual([]);
    wait();
    await tap(screen.getByRole("button", { name: /Submit answers/ }));
    expect(a.calls).toEqual([{ kind: "inbox.answer", args: { key: "group:123", rev: "rev-group-123", questions: [123, 124] } }]);
    expect(closed.get("group:123")?.reason).toBe("answered");
  });
});

describe("Inbox: placeholders and the footer", () => {
  const view = (topic: bridgeApi.InboxTopic, a = fakeAct(), closed = new ClosedRows()) => {
    const r = render(<Inbox topic={topic} host={demoHost} now={DEMO_NOW} act={a.fn} closed={closed} />);
    return { ...r, a, closed };
  };

  it("marks an alert seen from the footer, and shows it closed", async () => {
    const a = fakeAct([{ ok: true, closed: "acked" }]);
    const { closed } = view(typical(), a);
    expect(screen.getByText("Alert Title 456 needs no answer.")).toBeInTheDocument();
    await tap(screen.getByRole("button", { name: "Seen" }));
    expect(a.calls).toEqual([]);
    wait();
    await tap(screen.getByRole("button", { name: "Seen" }));
    expect(a.calls).toEqual([{ kind: "inbox.ack", args: { key: "alert:456", rev: "rev-alert-456" } }]);
    expect(closed.get("alert:456")?.reason).toBe("seen");
    expect(screen.getByText("✓ Alert Title 456 · seen")).toBeInTheDocument();
  });

  it("offers an undelivered answer's own verbs when it is selected", async () => {
    const a = fakeAct();
    view(inboxScenario("failed").topic, a);
    wait();
    await tap(screen.getByText("Answer to Q119 not delivered"));
    await tap(screen.getByRole("button", { name: "Retry delivery" }));
    await tap(screen.getByRole("button", { name: "Stop showing" }));
    expect(a.calls.map((c) => [c.kind, c.args.key])).toEqual([
      ["inbox.retry", "failed:119"],
      ["inbox.stop_showing", "failed:119"],
    ]);
  });

  it("a row that leaves while shown stays as a placeholder until the operator moves", async () => {
    const t = typical();
    const { rerender, closed, a } = view(t);
    rerender(<Inbox topic={{ ...t, entries: t.entries.filter((e) => e.key !== "group:127") }} host={demoHost} now={DEMO_NOW} act={a.fn} closed={closed} />);
    expect(screen.getByText("✓ Question Title 127 · closed")).toBeInTheDocument();
    wait(ROW_ARM_MS);
    await tap(screen.getByText("Alert Title 456"));
    expect(screen.queryByText("✓ Question Title 127 · closed")).toBeNull();
  });

  it("a row that has just arrived takes no tap", async () => {
    const t = typical();
    const { rerender, closed, a } = view({ ...t, entries: t.entries.filter((e) => e.key !== "alert:456") });
    wait();
    rerender(<Inbox topic={t} host={demoHost} now={DEMO_NOW} act={a.fn} closed={closed} />);
    const alertRow = screen.getByText("Alert Title 456").closest("button") as HTMLElement;
    await tap(alertRow);
    expect(alertRow).not.toHaveAttribute("aria-current");
    await tap(screen.getByRole("button", { name: "Seen" }));
    expect(a.calls).toEqual([]);
    wait(ROW_ARM_MS);
    await tap(alertRow);
    expect(alertRow).toHaveAttribute("aria-current", "true");
  });

  it("opens a group's first unanswered question on tap", async () => {
    view(typical());
    wait();
    await tap(within(screen.getByRole("list", { name: "Inbox" })).getByText("Question Title 123"));
    expect(window.location.hash).toBe("#/inbox/q/group%3A123/123");
  });
});

const DATA_JS = join(process.env.HERDR_INBOX_MODS ?? join(homedir(), "Code/herdr-inbox/app/mods/herdr-inbox"), "model/data.js");
describe.skipIf(!existsSync(DATA_JS))("arm delays against the inbox plugin (drift check, sibling checkout only)", () => {
  it("are the plugin's VIEW_ARM and ROW_ARM", () => {
    const text = readFileSync(DATA_JS, "utf8");
    expect(text).toMatch(new RegExp(`export const VIEW_ARM = ${VIEW_ARM_MS};`));
    expect(text).toMatch(new RegExp(`export const ROW_ARM = ${ROW_ARM_MS};`));
  });
});
