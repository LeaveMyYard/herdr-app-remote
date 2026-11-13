import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/screens/Chat";
import { collect } from "../src/components/Diagnostics";

const agent = { name: "Agent 1", folder: "tab 1", harness: "claude", status: "idle" } as const;
const input = { enabled: true, until: null, send: async () => ({ ok: true }) };
const row = (k: string | RegExp) => collect().find(([l]) => (typeof k === "string" ? l === k : k.test(l)));

afterEach(() => vi.unstubAllGlobals());

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

  it("lists the scroll offsets and .ph top on a chat screen", () => {
    render(<Chat agent={agent} topic={{ terminal: "t3", lines: [] }} terminal="t3" input={input} />);
    for (const k of [".ph top", "window.scrollY", "scrollingElement.scrollTop", "html.scrollTop", "body.scrollTop"]) expect(row(k), k).toBeDefined();
  });

  it("probes the composer, the send button and the two points below innerHeight, each labelled with its y, skipping the overlay", () => {
    const { container } = render(
      <div className="ph">
        <Chat agent={agent} topic={{ terminal: "t3", lines: [] }} terminal="t3" input={input} />
      </div>,
    );
    const rect = (top: number, h: number) => ({ top, bottom: top + h, left: 0, right: 100, width: 100, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(container.querySelector(".chat-form")!, "getBoundingClientRect").mockReturnValue(rect(800, 100));
    vi.spyOn(container.querySelector(".chat-send")!, "getBoundingClientRect").mockReturnValue(rect(830, 44));
    vi.spyOn(container.querySelector(".ph")!, "getBoundingClientRect").mockReturnValue(rect(0, 932));
    vi.stubGlobal("innerHeight", 873);
    // The overlay is on top of everything while it is open: the probe must look through it.
    const overlay = document.createElement("div");
    overlay.className = "diag";
    document.body.appendChild(overlay);
    document.elementsFromPoint = (_x: number, y: number) => (y > 873 ? [overlay] : [overlay, container.querySelector(".chat-form")!]);
    const labels = collect().filter(([k]) => k.startsWith("hit "));
    expect(labels.map(([k]) => k)).toEqual([
      "hit composer top (x 512 y 801)",
      "hit composer middle (x 512 y 850)",
      "hit composer bottom (x 512 y 899)",
      "hit send centre (x 50 y 852)",
      "hit just above innerHeight (x 512 y 872)",
      "hit between innerHeight and .ph bottom (x 512 y 902.5)",
    ]);
    expect(labels.map(([, v]) => v)).toEqual(["form.row nf chat-form", "form.row nf chat-form", "nothing (outside the layout viewport)", "form.row nf chat-form", "form.row nf chat-form", "nothing (outside the layout viewport)"]);
    overlay.remove();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });
});
