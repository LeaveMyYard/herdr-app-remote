import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "../src/components/Banner";
import { TabBar } from "../src/components/TabBar";

describe("TabBar", () => {
  it("shows the five tabs and marks the active one", () => {
    render(<TabBar active="swarm" badges={{}} onSelect={() => {}} />);
    const names = screen.getAllByRole("link").map((l) => l.textContent);
    expect(names).toEqual(["Agents", "Swarm", "Inbox", "Chat", "Usage"]);
    expect(screen.getByRole("link", { name: "Swarm" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Agents" })).not.toHaveAttribute("aria-current");
  });

  it("renders a badge only for tabs that have one", () => {
    render(<TabBar active="agents" badges={{ inbox: "?2" }} onSelect={() => {}} />);
    expect(screen.getByLabelText("Inbox: ?2")).toHaveTextContent("?2");
    expect(screen.queryByLabelText(/Chat:/)).toBeNull();
  });

  it("reports the selected tab", async () => {
    const onSelect = vi.fn();
    render(<TabBar active="agents" badges={{}} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(onSelect).toHaveBeenCalledWith("usage");
  });
});

describe("Banner", () => {
  it("renders nothing while online", () => {
    const { container } = render(<Banner connection={{ status: "online" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    [{ status: "connecting" as const }, /Connecting/, "s-q"],
    [{ status: "offline" as const }, /No connection/, "s-fail"],
    [{ status: "stale" as const, age: "2m" }, /Showing data from 2m ago/, "s-wait"],
  ])("shows the %o state", (connection, text, cls) => {
    render(<Banner connection={connection} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(text);
    expect(banner).toHaveClass(cls);
  });

  it("uses the plan's wording for layout_without_remote", () => {
    render(<Banner connection={{ status: "stale", reason: "layout_without_remote" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Switch to a layout with Remote");
  });

  it("falls back when a stale banner has no age", () => {
    render(<Banner connection={{ status: "stale" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing older data");
  });
});
