import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostNameProvider } from "../src/bridge/host-name";
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
    const { container } = render(<HostNameProvider name="desk-1"><Banner connection={{ status: "online" }} /></HostNameProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    [{ status: "connecting" as const }, /^Connecting to desk-1…$/, "s-q"],
    [{ status: "offline" as const }, /No connection/, "s-fail"],
    [{ status: "stale" as const, age: "2m" }, /Showing data from 2m ago/, "s-wait"],
  ])("shows the %o state", (connection, text, cls) => {
    render(<HostNameProvider name="desk-1"><Banner connection={connection} /></HostNameProvider>);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(text);
    expect(banner).toHaveClass(cls);
  });

  it("uses the plan's wording for layout_without_remote", () => {
    render(<HostNameProvider name="desk-1"><Banner connection={{ status: "stale", reason: "layout_without_remote" }} /></HostNameProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Switch to a layout with Remote");
  });

  it("falls back when a stale banner has no age", () => {
    render(<HostNameProvider name="desk-1"><Banner connection={{ status: "stale" }} /></HostNameProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Showing older data");
  });
});

describe("Banner: the approved PhoneBanners copy (design/COPY.md)", () => {
  it.each([
    ["unpaired", "s-wait", "This phone isn't paired yet.", "Scan a fresh code from Remote › Devices on desk-1 with the iPhone Camera."],
    ["refused", "s-fail", "desk-1 no longer accepts this phone.", "It was removed, or this phone uses another account. Scan a fresh code from Remote › Devices with the iPhone Camera."],
    ["paused", "s-q", "Remote access is paused on desk-1.", "Resume it in Remote on the computer. This reconnects by itself."],
    ["unavailable", "s-wait", "Can't reach desk-1.", "It may be asleep or offline. Trying again every 10 s."],
  ] as const)("%s: title, second line and hue", (status, cls, title, sub) => {
    render(<HostNameProvider name="desk-1"><Banner connection={{ status }} onRetry={() => undefined} /></HostNameProvider>);
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass(cls);
    expect(banner.querySelector(".banner-title")).toHaveTextContent(title);
    expect(banner.querySelector(".banner-sub")).toHaveTextContent(sub);
  });

  it("unavailable has Retry now, which calls back; no other state has a button", async () => {
    const onRetry = vi.fn();
    const { unmount } = render(<HostNameProvider name="desk-1"><Banner connection={{ status: "unavailable" }} onRetry={onRetry} /></HostNameProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
    for (const status of ["unpaired", "refused", "paused", "connecting", "offline"] as const) {
      const r = render(<HostNameProvider name="desk-1"><Banner connection={{ status }} onRetry={onRetry} /></HostNameProvider>);
      expect(screen.queryByRole("button")).toBeNull();
      r.unmount();
    }
  });

  it("names the computer it was given", () => {
    render(<HostNameProvider name="desk-9"><Banner connection={{ status: "refused" }} /></HostNameProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("desk-9 no longer accepts this phone.");
  });
});
