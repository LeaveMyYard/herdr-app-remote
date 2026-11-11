import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { agents, host, plugins, spaces } from "../src/fixtures";
import { AgentsBasic } from "../src/screens/AgentsBasic";
import { Missing } from "../src/screens/Missing";

describe("AgentsBasic", () => {
  it("groups agents under their space with a count", () => {
    render(<AgentsBasic host={host} spaces={spaces} agents={agents} />);
    const alpha = screen.getByRole("group", { name: "Project Alpha" });
    expect(within(alpha).getAllByRole("link").map((l) => l.textContent)).toEqual(["Agent 1· tab 226mNeeds you", "Agent 2· tab 39m"]);
    expect(alpha).toHaveTextContent("Project Alpha2");
    expect(screen.queryByRole("group", { name: "Sandbox" })).toBeNull();
  });

  it("marks the agent that needs you and shows each working state by role", () => {
    render(<AgentsBasic host={host} spaces={spaces} agents={agents} />);
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Working" })).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument();
  });

  it("shows space metadata: branch, behind count and detached", () => {
    render(<AgentsBasic host={host} spaces={spaces} agents={agents} />);
    expect(screen.getByText("alpha-core")).toBeInTheDocument();
    expect(screen.getByText("↓12")).toBeInTheDocument();
    expect(screen.getByText("(detached)")).toBeInTheDocument();
  });

  it("names the host in the panorama hint", () => {
    render(<AgentsBasic host={{ name: "desk-9" }} spaces={spaces} agents={agents} />);
    expect(screen.getByText(/Install it in herdr-app on desk-9/)).toBeInTheDocument();
  });

  it("draws idle as a ring and mutes the name", () => {
    render(<AgentsBasic host={host} spaces={spaces} agents={[{ ...agents[0]!, status: "idle" }]} />);
    expect(screen.getByRole("img", { name: "Idle" })).toHaveClass("dot-ring");
    expect(screen.getByRole("link")).toHaveAttribute("data-status", "idle");
  });

  it("masks animated spinners for the visual harness", () => {
    const { container } = render(<AgentsBasic host={host} spaces={spaces} agents={agents} />);
    expect(container.querySelectorAll("[data-vis-mask]")).toHaveLength(2);
  });
});

describe("Missing", () => {
  const props = {
    host,
    title: "Agent Usage",
    plugin: "agent-usage",
    blurb: "This tab shows how much of each Claude and Codex account is left.",
    command: "[AGENT-USAGE INSTALL COMMAND]",
    plugins,
  };

  it("explains what is missing and where", () => {
    render(<Missing {...props} />);
    expect(screen.getByRole("heading")).toHaveTextContent("agent-usage isn't installed");
    expect(screen.getByText(/It needs the agent-usage plugin in herdr-app on desk-1\./)).toBeInTheDocument();
  });

  it("lists each plugin with its state and version", () => {
    render(<Missing {...props} />);
    const card = screen.getByRole("region", { name: "Plugins on desk-1" });
    expect(within(card).getByText("ready · 0.4")).toBeInTheDocument();
    expect(within(card).getByText("ready · 0.10")).toBeInTheDocument();
    expect(within(card).getByText("not installed")).toBeInTheDocument();
  });

  it("copies the install command and confirms", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(<Missing {...props} onCopy={onCopy} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledWith("[AGENT-USAGE INSTALL COMMAND]");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("maps every protocol plugin state to a label", () => {
    const states = ["ready", "missing", "too_old", "broken", "stale", "not_running"] as const;
    render(<Missing {...props} plugins={states.map((state) => ({ name: `p-${state}`, state }))} />);
    const card = screen.getByRole("region", { name: "Plugins on desk-1" });
    for (const label of ["ready", "not installed", "too old", "broken", "stale", "not running"]) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
  });

  it("stays on Copy when the clipboard refuses", async () => {
    const onCopy = vi.fn().mockRejectedValue(new Error("denied"));
    render(<Missing {...props} onCopy={onCopy} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
