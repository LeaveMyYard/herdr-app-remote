import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chat } from "../src/screens/Chat";
import { collect } from "../src/components/Diagnostics";

const agent = { name: "Agent 1", folder: "tab 1", harness: "claude", status: "idle" } as const;

describe("diagnostics on the chat screen", () => {
  it("five taps on the chat title open the overlay, with the footer's boxes", () => {
    const { container, getByRole, queryByRole } = render(<Chat agent={agent} topic={{ terminal: "t3", lines: [] }} />);
    expect(queryByRole("dialog")).toBeNull();
    const title = container.querySelector(".chat-title")!;
    for (let i = 0; i < 5; i++) fireEvent.click(title);
    expect(getByRole("dialog", { name: "Diagnostics" }).textContent).toContain(".chat-foot");
  });
  it("lists no chat rows off the chat screen", () => {
    expect(collect().some(([k]) => k === ".chat-foot")).toBe(false);
  });
});
