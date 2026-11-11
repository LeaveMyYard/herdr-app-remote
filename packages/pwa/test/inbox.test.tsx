import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { DEMO_NOW, demoHost, inboxInstallCommand, inboxScenario } from "../src/inbox-fixtures";
import { age, goneBatch, groupSub, inboxBadge, whereOf } from "../src/inbox/model";
import { plugins, host as hostInfo } from "../src/fixtures";
import { Inbox } from "../src/screens/Inbox";
import { InboxTab } from "../src/screens/InboxTab";

const topic = (name: string) => inboxScenario(name).topic;
const view = (name: string, over: Partial<Parameters<typeof Inbox>[0]> = {}) => render(<Inbox topic={topic(name)} host={demoHost} now={DEMO_NOW} {...over} />);

beforeEach(() => {
  window.location.hash = "";
});

describe("Inbox", () => {
  it("shows the board: counts, numbered groups, ages, who asked, and what is new", () => {
    view("typical");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Inbox");
    expect(screen.getByText("2 waiting · 1 alert")).toBeInTheDocument();
    expect(screen.getByText("2 groups")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Inbox" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      "❯1.Question Title 123new2mAgent 1 · Project Alpha · 3 questions · 1 answered",
      "2.Question Title 12714mAgent 3 · Project Beta · 1 question",
      "⚠Alert Title 4569mAgent 3 · Project Beta",
    ]);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
  });

  it("moves the selection to the row that is tapped", async () => {
    view("typical");
    const rows = screen.getAllByRole("button");
    await userEvent.click(rows[1]!);
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
  });

  it("marks an old feed, with its age, and still shows the rows", () => {
    view("stale");
    expect(screen.getByRole("status")).toHaveTextContent("The inbox feed can't be read (unreadable): this is the last good copy, 5m old. It may be out of date.");
    expect(screen.getByText("Alert Title 456")).toBeInTheDocument();
  });

  it("says what the feed left out, and never shows the empty state while anything is left out", () => {
    view("left-out-only");
    expect(screen.getByRole("status")).toHaveTextContent("Still open, and not listed here: 1 question, 1 group. 1 question is not shown yet");
    expect(screen.queryByText("No open questions")).toBeNull();
    // left-out questions still wait: the header, the count and the badge never say "nothing"
    expect(screen.getByText("1 waiting")).toBeInTheDocument();
    expect(screen.getByText("1 group")).toBeInTheDocument();
    expect(inboxBadge(topic("left-out-only"))).toBe("?1");
  });

  it("repeats the feed's own error lines", () => {
    view("incomplete");
    expect(screen.getByRole("status")).toHaveTextContent("a remote machine was not read");
    expect(screen.getByText("Alert Title 456")).toBeInTheDocument();
  });

  it("shows the empty state only for an empty inbox", () => {
    view("empty");
    expect(screen.getAllByText("No open questions")).toHaveLength(2);
  });

  it("says the inbox is unavailable, not empty, when there is no feed", () => {
    view("unavailable");
    expect(screen.getAllByText("Inbox unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/There is no inbox feed to read \(missing\)/)).toBeInTheDocument();
    expect(screen.queryByText("No open questions")).toBeNull();
  });

  it("explains an inbox that is too old", () => {
    view("too-old");
    expect(screen.getByText("herdr-inbox is too old for the app.")).toBeInTheDocument();
  });

  it("shows words it does not know as a key, with nothing offered", () => {
    view("unknown");
    const row = screen.getByText("wat:1").closest("button")!;
    expect(row).toHaveTextContent("wat:1");
    expect(screen.getByText("Machine 1")).toBeInTheDocument();
  });

  it("folds two or more gone-agent answers into one row, and keeps that set fixed", () => {
    const t = topic("failed");
    const { rerender } = render(<Inbox topic={t} host={demoHost} now={DEMO_NOW} />);
    expect(screen.getByText("2 answers whose agents are gone")).toBeInTheDocument();
    expect(screen.queryByText("Question Title 120")).toBeNull();
    // the busy (pending) answer is no failure: it reads as delivery at work
    expect(screen.getByText("Question Title 119").closest("button")).toHaveTextContent("⏳");
    // a third gone answer that arrives later gets its own row
    const extra = { ...t.entries.find((e) => e.key === "failed:120")!, key: "failed:122", question_id: 122, question: "Question Title 122" };
    rerender(<Inbox topic={{ ...t, entries: [...t.entries, extra as never] }} host={demoHost} now={DEMO_NOW} />);
    expect(screen.getByText("Question Title 122")).toBeInTheDocument();
    expect(screen.getByText("2 answers whose agents are gone")).toBeInTheDocument();
  });

  it("keeps the summary when the batch shrinks to one, so the answer never disappears", () => {
    const t = topic("failed");
    const { rerender } = render(<Inbox topic={t} host={demoHost} now={DEMO_NOW} />);
    rerender(<Inbox topic={{ ...t, entries: t.entries.filter((e) => e.key !== "failed:121") }} host={demoHost} now={DEMO_NOW} />);
    expect(screen.getByText("1 answer whose agent is gone")).toBeInTheDocument();
    rerender(<Inbox topic={{ ...t, entries: t.entries.filter((e) => !e.key.startsWith("failed:12")) }} host={demoHost} now={DEMO_NOW} />);
    expect(screen.queryByText(/whose agent/)).toBeNull();
  });

  it("puts the summary right after the failed rows", () => {
    const t = topic("failed");
    const remote = topic("unknown").entries.find((e) => e.kind === "remote_group")!;
    render(<Inbox topic={{ ...t, entries: [...t.entries, remote] }} host={demoHost} now={DEMO_NOW} />);
    const keys = within(screen.getByRole("list", { name: "Inbox" })).getAllByRole("listitem").map((li) => li.querySelector("[data-key]")?.getAttribute("data-key"));
    expect(keys.slice(-2)).toEqual(["gone", "remote:m1|db|3"]);
  });

  it("does not fold a single gone-agent answer", () => {
    const t = topic("failed");
    render(<Inbox topic={{ ...t, entries: t.entries.filter((e) => e.key !== "failed:121") }} host={demoHost} now={DEMO_NOW} />);
    expect(screen.getByText("Question Title 120")).toBeInTheDocument();
    expect(screen.queryByText(/answers whose agents are gone/)).toBeNull();
  });
});

describe("InboxTab", () => {
  it("shows the not-installed screen when herdr-inbox is missing", () => {
    render(<InboxTab host={hostInfo} topic={topic("missing")} plugins={plugins} installCommand={inboxInstallCommand} now={DEMO_NOW} />);
    expect(screen.getByRole("heading")).toHaveTextContent("herdr-inbox isn't installed");
  });
});

describe("App", () => {
  it("opens the Inbox tab with its badge from the topic", () => {
    window.location.hash = "#/inbox";
    render(<App />);
    expect(screen.getByRole("link", { name: /^Inbox/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Question Title 123")).toBeInTheDocument();
    expect(screen.getByLabelText("Inbox: ?2")).toBeInTheDocument();
  });

  it("follows the scenario in the hash", () => {
    window.location.hash = "#/inbox/empty";
    render(<App />);
    expect(screen.getAllByText("No open questions").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/Inbox: \?/)).toBeNull();
  });
});

describe("inbox model", () => {
  it("ages like the inbox's own words: now, minutes, hours, days", () => {
    const at = (s: number) => new Date((DEMO_NOW - s) * 1000).toISOString();
    expect([age(at(5), DEMO_NOW), age(at(120), DEMO_NOW), age(at(7200), DEMO_NOW), age(at(200000), DEMO_NOW), age("nonsense", DEMO_NOW), age(null, DEMO_NOW)]).toEqual(["now", "2m", "2h", "2d", "", ""]);
  });

  it("finds a core asker by its terminal, a herdr-tui asker by its pane, and falls back to the tab label then the directory", () => {
    const base = { host: "herdr-core" as const, pane: null, terminal: null, tab_label: null, cwd: null };
    expect(whereOf({ ...base, terminal: "t1" }, demoHost)).toEqual({ agent: "Agent 1", space: "Project Alpha" });
    expect(whereOf({ ...base, host: "herdr-tui", pane: "pane-4" }, demoHost)).toEqual({ agent: "Agent 3", space: "Project Beta" });
    expect(whereOf({ ...base, terminal: "t9", tab_label: "Tab 5" }, demoHost)).toEqual({ agent: null, space: "Tab 5" });
    expect(whereOf({ ...base, host: "unknown", cwd: "/work/project-gamma/" }, demoHost)).toEqual({ agent: null, space: "project-gamma" });
    expect(whereOf({ ...base, terminal: "t1" }, undefined)).toEqual({ agent: null, space: null });
  });

  it("counts stored drafts as answered and says when text was cut", () => {
    const g = topic("typical").entries[0] as Parameters<typeof groupSub>[0];
    expect(groupSub(g, demoHost)).toBe("Agent 1 · Project Alpha · 3 questions · 1 answered");
    expect(groupSub({ ...g, questions: [{ ...g.questions[0]!, cut: true }] }, demoHost)).toBe("Agent 1 · Project Alpha · 1 question · text cut");
  });

  it("badges the tab with the waiting groups only when a feed is held", () => {
    expect(inboxBadge(topic("typical"))).toBe("?2");
    expect(inboxBadge(topic("empty"))).toBeUndefined();
    expect(inboxBadge(topic("unavailable"))).toBeUndefined();
    expect(inboxBadge(undefined)).toBeUndefined();
  });

  it("folds gone-agent rows only when there are two", () => {
    const rows = topic("failed").entries;
    expect(goneBatch(rows)).toEqual(["failed:120", "failed:121"]);
    expect(goneBatch(rows.filter((r) => r.key !== "failed:121"))).toEqual([]);
  });
});
