import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";

beforeEach(() => {
  window.location.hash = "";
});

describe("App", () => {
  it("opens on Agents", () => {
    render(<App />);
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
  });

  it("opens the tab named in the hash and follows hash changes", () => {
    window.location.hash = "#/usage/missing";
    render(<App />);
    expect(screen.getByRole("heading")).toHaveTextContent("agent-usage isn't installed");
    act(() => {
      window.location.hash = "#/agents";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
  });

  it("switches tabs from the tab bar and keeps the hash in step", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(window.location.hash).toBe("#/usage");
    expect(screen.getByRole("link", { name: "Usage" })).toHaveAttribute("aria-current", "page");
  });

  it("falls back to Agents for an unknown hash", () => {
    window.location.hash = "#/nope";
    render(<App />);
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the connection banner when the browser goes offline and clears it when back", () => {
    render(<App />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("No connection");
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lets the bridge client override the connection state", () => {
    render(<App connection={{ status: "stale", age: "5m" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing data from 5m ago");
  });
});
