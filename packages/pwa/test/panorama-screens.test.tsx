import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { agentsTopic, BOARD_NOW, boardData, boardHost, boardSpaceExtra, peekTranscript, plugins, swarmTopic, swarmUi } from "../src/fixtures";
import { nodeUid, selectAgents, swarmScope, type SwarmUi } from "../src/panorama/select";
import { AgentsRich } from "../src/screens/AgentsRich";
import { Peek } from "../src/screens/Peek";
import { Swarm } from "../src/screens/Swarm";
import { SwarmUnavailable } from "../src/screens/SwarmUnavailable";

beforeEach(() => {
  window.location.hash = "";
});

describe("AgentsRich", () => {
  const view = selectAgents(boardHost, agentsTopic, boardSpaceExtra);
  it("lists each space with its agents, badge and subagent counts", () => {
    render(<AgentsRich view={view} />);
    const alpha = screen.getByRole("group", { name: "Project Alpha" });
    expect(alpha).toHaveTextContent("Project Alpha3");
    const first = within(alpha).getAllByRole("link")[0]!;
    expect(first).toHaveTextContent("Agent 1 · Parser rewrite");
    expect(first).toHaveTextContent("Running");
    expect(first).toHaveTextContent("Project Alpha · tab 2 · 2 active · 3 agents");
    expect(first).toHaveAttribute("href", "#/swarm/sp-1");
  });
  it("shows the open question total in the header and on the card", () => {
    render(<AgentsRich view={view} />);
    expect(screen.getByLabelText("1 open questions")).toHaveTextContent("?1");
  });
  it("ends with the board's inert New agent row", () => {
    render(<AgentsRich view={view} />);
    expect(screen.getByText("New agent")).toBeInTheDocument();
  });
  it("hides the question total when there are none", () => {
    render(<AgentsRich view={{ ...view, questions: 0 }} />);
    expect(screen.queryByLabelText(/open questions/)).toBeNull();
  });
  it("masks the animated marks for the visual harness", () => {
    const { container } = render(<AgentsRich view={view} />);
    expect(container.querySelectorAll(".psweep[data-vis-mask]").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".tile.s-wait[data-vis-mask]").length).toBeGreaterThan(0);
  });
  it("draws an unsupported harness with the generic icon, never Claude's", () => {
    const v = selectAgents({ ...boardHost, agents: [{ id: "g", name: "Agent G", harness: "gemini", state: "idle", space_id: "sp-1" }] }, { ...agentsTopic, roots: [] });
    const { container } = render(<AgentsRich view={v} />);
    const src = container.querySelector(".pcard img")?.getAttribute("src") ?? "";
    expect(src).toMatch(/agent/);
    expect(src).not.toMatch(/claude|codex/);
  });
});

function Harness({ initial, transcript }: { initial: SwarmUi | null; transcript?: boolean }) {
  const [ui, setUi] = useState<SwarmUi>(initial ?? { open: {}, sel: null });
  return <Swarm scope={swarmScope(boardHost, swarmTopic, "sp-1")} ui={ui} onUi={setUi} now={BOARD_NOW} transcript={transcript ?? false} />;
}

describe("Swarm", () => {
  it("shows the header counts and the tree with the selected row's details and buttons", () => {
    render(<Harness initial={swarmUi} transcript />);
    expect(screen.getByText("Project Alpha · 3 roots · 7 agents")).toBeInTheDocument();
    expect(screen.getByLabelText("1 open questions")).toHaveTextContent("?1");
    expect(screen.getByText("Explore a1b2c3d4e5f6 · opus · <1m · 42 calls")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Peek ⏎" })).toHaveAttribute("href", `#/swarm/peek/${encodeURIComponent(nodeUid(swarmTopic.roots[0]!, "a1b2c3d4e5f6"))}`);
    expect(screen.getByRole("link", { name: "Transcript t" })).toBeInTheDocument();
    expect(screen.getByText("Answer a")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("1 finished · Docs · README pass")).toBeInTheDocument();
  });
  it("offers no Transcript button without a transcript source", () => {
    render(<Harness initial={swarmUi} />);
    expect(screen.queryByRole("link", { name: /Transcript/ })).toBeNull();
  });
  it("opens and selects a node on click and on Enter, and shows its children", async () => {
    render(<Harness initial={null} />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    const root = screen.getByRole("treeitem", { name: /Agent 1/ });
    expect(root).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(root);
    expect(screen.getByRole("treeitem", { name: /Agent 1/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: /Explore · token passes/ })).toBeInTheDocument();
    const plan = screen.getByRole("treeitem", { name: /Plan · split strategy/ });
    plan.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("treeitem", { name: /Explore · lexer edge cases/ })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("treeitem", { name: /Explore · lexer edge cases/ })).toBeNull();
  });
  it("a fold row is not selectable", async () => {
    render(<Harness initial={swarmUi} />);
    const before = screen.getAllByRole("treeitem").length;
    await userEvent.click(screen.getByText("1 finished · Docs · README pass"));
    expect(screen.getAllByRole("treeitem")).toHaveLength(before);
    expect(screen.getByRole("treeitem", { name: /Explore · token passes/ })).toHaveAttribute("aria-selected", "true");
  });
  it("says so when a scope has no trees and shows a notice above the tree", () => {
    const { rerender } = render(<Swarm scope={{ label: "Sandbox", roots: [] }} ui={{ open: {}, sel: null }} onUi={() => {}} now={BOARD_NOW} />);
    expect(screen.getByText("No agent trees in Sandbox yet.")).toBeInTheDocument();
    rerender(<Swarm scope={swarmScope(boardHost, swarmTopic, "sp-1")} ui={{ open: {}, sel: null }} onUi={() => {}} now={BOARD_NOW} notice="The feed can't be read (feed invalid)." />);
    expect(screen.getByRole("note")).toHaveTextContent("feed invalid");
  });
  it("shows an unknown status neutrally, not as done or needs-you", () => {
    const r = { ...swarmTopic.roots[1]!, status: "unknown" as const };
    render(<Swarm scope={{ label: "X", roots: [r] }} ui={{ open: {}, sel: null }} onUi={() => {}} now={BOARD_NOW} />);
    const item = screen.getByRole("treeitem");
    expect(item).toHaveClass("s-idle");
    expect(item).toHaveTextContent("Unknown");
    expect(item.querySelector(".gpulse")).toBeNull();
  });
});

describe("Peek", () => {
  const r = swarmTopic.roots[0]!;
  const blk = r.agents.find((a) => a.id === "a9f8e7d6")!;
  const base = { root: r, node: blk, spaceName: "Project Alpha", now: BOARD_NOW, closeHref: "#/swarm/sp-1" };
  it("shows the feed fields: facts, owner, the blocked reason and the last message", () => {
    render(<Peek {...base} />);
    expect(screen.getByText("Review · parse/mod.rs")).toBeInTheDocument();
    expect(screen.getByText("Review a9f8e7d6 · opus · 1m · 3 calls")).toBeInTheDocument();
    expect(screen.getByText("Subagent of Project Alpha · Agent 1 · Parser rewrite. It has no pane of its own.")).toBeInTheDocument();
    expect(screen.getByText("Blocked: needs permission to run cargo fmt.")).toBeInTheDocument();
    expect(screen.getByText("I want to run cargo fmt before suggesting edits.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Close" })).toHaveAttribute("href", "#/swarm/sp-1");
  });
  it("has no transcript section and no Open root pane unless they are available", () => {
    render(<Peek {...base} />);
    expect(screen.queryByText("Transcript")).toBeNull();
    expect(screen.queryByText("Open root pane")).toBeNull();
  });
  it("shows the transcript page and Open root pane when supplied", () => {
    render(<Peek {...base} transcript={peekTranscript} openRootHref="#/chat/a-1" />);
    expect(screen.getByText("41–80 / 80")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("link", { name: /Open root pane/ })).toHaveAttribute("href", "#/chat/a-1");
  });
  it("states a failure with the feed's error, and says plainly when there is none", () => {
    const { rerender } = render(<Peek {...base} node={{ ...blk, status: "fail", error: "exit 1", pending: [] }} />);
    expect(screen.getByText("Failed: exit 1.")).toBeInTheDocument();
    rerender(<Peek {...base} node={{ ...blk, status: "fail", error: null, pending: [] }} />);
    expect(screen.getByText("Failed: no detail available.")).toBeInTheDocument();
    rerender(<Peek {...base} node={{ ...blk, status: "run", pending: [] }} />);
    expect(screen.queryByText(/^Blocked|^Failed|^Waiting/)).toBeNull();
  });
  it("a missing value stays unavailable, not invented", () => {
    render(<Peek {...base} spaceName={null} node={{ ...blk, model: null, last_message: "", last_at: null, started: null }} />);
    expect(screen.getByText("Review a9f8e7d6 · 3 calls")).toBeInTheDocument();
    expect(screen.queryByText("Last message")).toBeNull();
    expect(screen.getByText("Subagent of Agent 1 · Parser rewrite. It has no pane of its own.")).toBeInTheDocument();
  });
});

describe("SwarmUnavailable", () => {
  it("explains what is needed and shows the panorama plugin state, with the feed error when there is one", () => {
    render(<SwarmUnavailable host={{ name: "desk-1" }} error="feed missing" plugins={plugins} />);
    expect(screen.getByRole("heading")).toHaveTextContent("The swarm isn't available");
    expect(screen.getByText(/feed missing/)).toBeInTheDocument();
    expect(screen.getByText("herdr-panorama")).toBeInTheDocument();
    expect(screen.queryByText("agent-usage")).toBeNull();
  });
});

describe("App with panorama data", () => {
  it("shows the rich Agents list when the topic is rich", () => {
    render(<App data={boardData("agents")} />);
    expect(screen.getByText("Agent 1 · Parser rewrite")).toBeInTheDocument();
    expect(screen.getByText("Project Alpha · tab 2 · 2 active · 3 agents")).toBeInTheDocument();
  });
  it("falls back to Basic Agents with no lease owner, and the Swarm tab says it isn't available", () => {
    const basic = { host: boardHost, panorama: { mode: "basic" as const, stale: false, aged: false, error: null, collected_at: null, roots: [] }, now: BOARD_NOW };
    window.location.hash = "#/agents";
    const { unmount } = render(<App data={basic} />);
    expect(screen.getByText(/Subagent trees and the Swarm view need herdr-panorama/)).toBeInTheDocument();
    expect(screen.getByText("Agent 1 · Parser rewrite")).toBeInTheDocument();
    unmount();
    window.location.hash = "#/swarm";
    render(<App data={basic} />);
    expect(screen.getByRole("heading")).toHaveTextContent("The swarm isn't available");
  });
  it("a feed error keeps the retained swarm on screen with a stale banner and a notice, never an empty one", () => {
    const stale = { ...swarmTopic, stale: true, error: "feed invalid" };
    window.location.hash = "#/swarm/sp-1";
    render(<App data={{ host: boardHost, panorama: stale, now: BOARD_NOW + 120, swarmUi }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing data from 2m ago");
    expect(screen.getByRole("note")).toHaveTextContent("feed invalid");
    expect(screen.getByText("Project Alpha · 3 roots · 7 agents")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(3);
  });
  it("while aged it shows every retained root, with a notice that nothing is matched to spaces", () => {
    const aged = { ...agentsTopic, aged: true, stale: true, roots: agentsTopic.roots.map((r) => ({ ...r, agent_id: null, space_id: null, live: false })) };
    window.location.hash = "#/swarm";
    render(<App data={{ host: boardHost, panorama: aged, now: BOARD_NOW }} />);
    expect(screen.getByText(/All roots · 7 roots/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("more than 15 s old");
  });
  it("opens Peek from the hash, and falls back to the Swarm when the node is gone", () => {
    window.location.hash = `#/swarm/peek/${encodeURIComponent(nodeUid(swarmTopic.roots[0]!, "a9f8e7d6"))}`;
    const { unmount } = render(<App data={boardData("peek")} />);
    expect(screen.getByRole("region", { name: "Peek" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("link", { name: /Open root pane/ })).toHaveAttribute("href", "#/chat/a-1");
    unmount();
    window.location.hash = `#/swarm/peek/${encodeURIComponent("gone")}`;
    render(<App data={boardData("peek")} />);
    expect(screen.queryByRole("region", { name: "Peek" })).toBeNull();
    expect(screen.getByRole("tree", { name: "Swarm" })).toBeInTheDocument();
  });
  it("an unmatched root's card opens a Swarm that contains it, and Peek closes back to it", async () => {
    const loose = { ...swarmTopic.roots[0]!, key: "x1", agent_id: null, space_id: null, live: false, title: "Loose root" };
    const t = { ...swarmTopic, roots: [...swarmTopic.roots, loose] };
    window.location.hash = "#/agents";
    const { unmount } = render(<App data={{ host: boardHost, panorama: t, now: BOARD_NOW }} />);
    const href = screen.getByRole("link", { name: /Loose root/ }).getAttribute("href");
    expect(href).toBe("#/swarm/all");
    unmount();
    window.location.hash = href!;
    render(<App data={{ host: boardHost, panorama: t, now: BOARD_NOW }} />);
    expect(screen.getByText(/All spaces · 4 roots/)).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Loose root/ })).toBeInTheDocument();
  });
  it("a malformed hash does not blank the app", () => {
    window.location.hash = "#/swarm/%E0";
    render(<App data={boardData("swarm")} />);
    expect(screen.getByRole("tree", { name: "Swarm" })).toBeInTheDocument();
  });
  it("without data the app is unchanged: Basic Agents from fixtures", () => {
    render(<App />);
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
    expect(boardData(null)).toBeUndefined();
  });
});
