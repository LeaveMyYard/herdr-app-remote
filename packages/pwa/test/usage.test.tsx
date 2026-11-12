import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { bridgeApi } from "@herdr-remote/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { host, plugins } from "../src/fixtures";
import { Usage } from "../src/screens/Usage";
import { UsageTab } from "../src/screens/UsageTab";
import { ago, clock, groupProviders, metaLine, hint } from "../src/usage-model";
import { demoUsage, demoUsageNow } from "../src/usage-fixtures";

const noop = () => undefined;
const base = { topic: demoUsage, now: demoUsageNow, view: "full" as const, onView: noop, onFilter: noop, onRefresh: noop };

beforeEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

describe("usage model", () => {
  const providers = (demoUsage.report as bridgeApi.UsageReport).providers;

  it("folds an entry for an account already listed into that account's row", () => {
    const groups = groupProviders(providers);
    expect(groups.map((g) => [g.family, g.members.map((m) => m.providerId)])).toEqual([
      ["claude", ["claude-1", "claude-2", "claude-3"]],
      ["codex", ["codex"]],
    ]);
    expect(hint(groups[0]!.members[1]!)).toBe("user-2@example.com · also claude");
  });

  it("hides providers with nothing on this machine", () => {
    const hidden = providers.map((p) => (p.providerId === "codex" ? { ...p, inUse: false } : p));
    expect(groupProviders(hidden).map((g) => g.family)).toEqual(["claude"]);
  });

  it("words ages like the desktop panel", () => {
    expect(ago(1000, 1000)).toBe("just now");
    expect(ago(0, 59 * 60_000)).toBe("59m ago");
    expect(ago(0, 47 * 3_600_000)).toBe("47h ago");
    expect(ago(0, 72 * 3_600_000)).toBe("3d ago");
  });

  it("formats the clock in local time", () => {
    const d = new Date(2026, 10, 3, 7, 5);
    expect(clock(d.getTime())).toBe("07:05");
  });

  it("builds the meta line for fresh, stale and window-less entries", () => {
    const [c1, , c3] = groupProviders(providers)[0]!.members;
    expect(metaLine(c1!, demoUsageNow)).toBe("claude statusLine cache · updated just now");
    expect(metaLine(c3!, demoUsageNow)).toBe("stale ~1315m ago · claude statusLine cache");
    expect(metaLine({ ...c1!, windows: [] }, demoUsageNow)).toBe("claude statusLine cache");
    expect(metaLine({ ...c1!, source: null, windows: [] }, demoUsageNow)).toBe("no source");
  });
});

describe("Usage", () => {
  it("groups accounts by family with plan, count and hints", () => {
    render(<Usage {...base} />);
    const claude = screen.getByRole("region", { name: "Claude" });
    expect(claude).toHaveTextContent("3 accounts");
    expect(within(claude).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["claude-1", "claude-2", "claude-3"]);
    const codex = screen.getByRole("region", { name: "Codex" });
    expect(codex).toHaveTextContent("· Pro");
    expect(codex).toHaveTextContent("~/.codex");
    expect(screen.getByText("4 accounts")).toBeInTheDocument();
  });

  it("shows percent left, reset, run-out warning and the stale meta line", () => {
    render(<Usage {...base} />);
    const c1 = screen.getByRole("group", { name: "claude-1" });
    expect(c1).toHaveTextContent("7d");
    expect(c1).toHaveTextContent("15% left");
    expect(c1).toHaveTextContent("2d 12h");
    expect(c1).toHaveTextContent("empty in ~18h 56m");
    expect(screen.getByRole("group", { name: "claude-3" })).toHaveTextContent("stale ~1315m ago · claude statusLine cache");
    expect(screen.getByRole("group", { name: "claude-2" })).toHaveTextContent("also claude");
  });

  it("says used instead of left when the report counts what is used", () => {
    const topic = { ...demoUsage, report: { ...(demoUsage.report as bridgeApi.UsageReport), limitPercent: "used" as const } };
    render(<Usage {...base} topic={topic} />);
    expect(screen.getByRole("group", { name: "claude-1" })).toHaveTextContent("15% used");
  });

  it("sets the bar width from barFill and clamps it", () => {
    const report = demoUsage.report as bridgeApi.UsageReport;
    const providers = report.providers.map((p) => (p.providerId === "claude-1" ? { ...p, windows: [{ ...p.windows[0]!, barFill: 1.7 }] } : p));
    const { container } = render(<Usage {...base} topic={{ ...demoUsage, report: { ...report, providers } }} />);
    const fill = container.querySelector<HTMLElement>(".uacct .ubar i");
    expect(fill?.style.width).toBe("100%");
  });

  it("shows the clock of the last update and the 15 s cadence", () => {
    const at = new Date(2026, 10, 3, 11, 15).getTime();
    render(<Usage {...base} topic={{ ...demoUsage, updatedAtMs: at }} />);
    expect(screen.getByText("Updated 11:15 · every 15s")).toBeInTheDocument();
  });

  it("switches the filter and the view with pressed state", async () => {
    const onFilter = vi.fn();
    const onView = vi.fn();
    render(<Usage {...base} onFilter={onFilter} onView={onView} />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Full" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Open panes" }));
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onFilter).toHaveBeenCalledWith("open-panes");
    expect(onView).toHaveBeenCalledWith("compact");
  });

  it("draws one row per account in compact view, warning when one will run out", () => {
    render(<Usage {...base} view="compact" />);
    expect(screen.queryByRole("region", { name: "Claude" })).toBeNull();
    expect(screen.getByText("Claude claude-1")).toBeInTheDocument();
    expect(screen.getByText("codex Pro")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Will run out before reset" })).toHaveLength(2);
    expect(screen.getByLabelText("7d 99% left")).toBeInTheDocument();
  });

  it("shows a callout for a login to fix and no windows in compact view", () => {
    const report = demoUsage.report as bridgeApi.UsageReport;
    const needs = { providerId: "grok", family: "grok", label: "grok", status: "needs-login", action: "grok login", note: "Sign in with `grok login` first.", windows: [] };
    const topic = { ...demoUsage, report: { ...report, providers: [needs] } };
    const { rerender } = render(<Usage {...base} topic={topic} />);
    expect(screen.getByText("grok login", { selector: "code" })).toBeInTheDocument();
    rerender(<Usage {...base} topic={topic} view="compact" />);
    expect(screen.getByText("run grok login")).toBeInTheDocument();
    rerender(<Usage {...base} topic={{ ...topic, report: { ...(topic.report as bridgeApi.UsageReport), providers: [{ ...needs, action: "" }] } }} view="compact" />);
    expect(screen.getByText("no data")).toBeInTheDocument();
  });

  it("says when there is no usage yet for an account", () => {
    const report = demoUsage.report as bridgeApi.UsageReport;
    const codex = { providerId: "codex", family: "codex", label: "codex", identity: "~/.codex", home: "~/.codex", status: "no-data", windows: [] };
    const { rerender } = render(<Usage {...base} topic={{ ...demoUsage, report: { ...report, providers: [codex] } }} />);
    expect(screen.getByText("No usage yet · updates when Codex runs in ~/.codex")).toBeInTheDocument();
    // An email identity is not a place an agent runs in.
    const claude = { providerId: "claude-1", family: "claude", label: "claude-1", identity: "user-1@example.com", home: "~/.claude-1", status: "no-data", windows: [] };
    rerender(<Usage {...base} topic={{ ...demoUsage, report: { ...report, providers: [claude] } }} />);
    expect(screen.getByText("No usage yet · updates when Claude runs in ~/.claude-1")).toBeInTheDocument();
    rerender(<Usage {...base} topic={{ ...demoUsage, report: { ...report, providers: [{ ...claude, home: null }] } }} />);
    expect(screen.getByText("No usage yet")).toBeInTheDocument();
  });

  it("explains an empty Open panes list, and a not-yet-loaded topic", () => {
    const report = demoUsage.report as bridgeApi.UsageReport;
    const { rerender } = render(<Usage {...base} topic={{ filter: "open-panes", updatedAtMs: 1, report: { ...report, providers: [] } }} />);
    expect(screen.getByText("No agent panes open")).toBeInTheDocument();
    expect(screen.getByText(/Choose All to see every configured account/)).toBeInTheDocument();
    rerender(<Usage {...base} topic={undefined} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("4 accounts")).toBeNull();
  });

  it("keeps the last report on screen and names a collect error", () => {
    render(<Usage {...base} topic={{ ...demoUsage, error: "timeout" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("usagebar took too long to answer");
    expect(screen.getByRole("region", { name: "Claude" })).toBeInTheDocument();
  });

  it("names each error code without echoing anything from the CLI", () => {
    for (const code of ["unavailable", "timeout", "failed", "bad_output", "unsupported"] as const) {
      const { unmount } = render(<Usage {...base} topic={{ ...demoUsage, error: code }} />);
      expect(screen.getByRole("alert").textContent).toMatch(/^usagebar /);
      unmount();
    }
  });
});

describe("UsageTab", () => {
  const tab = (state: bridgeApi.PluginState, over = {}) => (
    <UsageTab host={host} state={state} topic={demoUsage} plugins={plugins} installCommand="[CMD]" now={demoUsageNow} onFilter={noop} onRefresh={noop} {...over} />
  );

  it("shows the Missing screen for a too_old agent-usage, with the update wording", () => {
    render(tab("too_old", { plugins: plugins.map((p) => (p.name === "agent-usage" ? { ...p, state: "too_old" as const } : p)) }));
    expect(screen.getByRole("heading")).toHaveTextContent("agent-usage needs an update");
    expect(screen.getByText(/is too old for this app/)).toBeInTheDocument();
    expect(screen.getByText("too old")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude" })).toBeNull();
  });

  it("shows Missing for missing and broken too, and the panel for every other state", () => {
    const { rerender } = render(tab("missing"));
    expect(screen.getByRole("heading")).toHaveTextContent("agent-usage isn't installed");
    rerender(tab("broken"));
    expect(screen.getByRole("heading")).toHaveTextContent("agent-usage isn't responding");
    for (const s of ["ready", "stale", "not_running"] as const) {
      rerender(tab(s));
      expect(screen.getByRole("region", { name: "Agent Usage" })).toBeInTheDocument();
    }
  });

  it("turns on by itself when the state becomes ready", () => {
    const { rerender } = render(tab("too_old"));
    rerender(tab("ready"));
    expect(screen.getByRole("region", { name: "Claude" })).toBeInTheDocument();
  });

  it("remembers the view across mounts", async () => {
    const { unmount } = render(tab("ready"));
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(window.localStorage.getItem("usage.view")).toBe("compact");
    unmount();
    render(tab("ready"));
    expect(screen.getByRole("button", { name: "Compact" })).toHaveAttribute("aria-pressed", "true");
  });

  it("refreshes once at a time and shows it is busy", async () => {
    let done: () => void = noop;
    const onRefresh = vi.fn(() => new Promise<void>((r) => (done = r)));
    render(tab("ready", { onRefresh }));
    const button = screen.getByRole("button", { name: /Refresh/ });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    await act(async () => done());
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("survives a refresh that throws", async () => {
    const onRefresh = vi.fn().mockRejectedValue(new Error("x"));
    render(tab("ready", { onRefresh }));
    await userEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Refresh/ })).not.toHaveAttribute("aria-busy");
  });
});

describe("App usage tab", () => {
  it("opens the Usage screen at #/usage and the scenarios behind it", () => {
    window.location.hash = "#/usage";
    const { unmount } = render(<App />);
    expect(screen.getByRole("region", { name: "Claude" })).toBeInTheDocument();
    unmount();
    window.location.hash = "#/usage/too_old";
    render(<App />);
    expect(screen.getByRole("heading")).toHaveTextContent("agent-usage needs an update");
  });

  it("follows the filter choice", async () => {
    window.location.hash = "#/usage";
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open panes" }));
    expect(screen.getByRole("button", { name: "Open panes" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Usage phone layout", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/usage.css"), "utf8");
  it("takes the phone's width: the panel carries no fixed width (it is zoomed 1.2, so 325px fell short of any phone wider than 390)", () => {
    expect(css).toMatch(/\.usage-z\{width:100%/);
    expect(css).not.toMatch(/\.usage-z\{[^}]*width:\d+px/);
  });
  it("puts the footer status on its own line and hides the key hint without a hover pointer", () => {
    expect(css).toMatch(/\.ufoot\{[^}]*flex-wrap:wrap/);
    expect(css).toMatch(/\.ufoot-status\{flex:1 1 100%\}/);
    expect(css).toMatch(/@media \(hover:none\),\(pointer:coarse\)\{\.ukey\{display:none\}\}/);
    const { container } = render(<Usage {...base} busy={false} />);
    expect(container.querySelector(".ufoot-status")?.textContent).toMatch(/^Updated \d\d:\d\d · every 15s$/);
  });
});
