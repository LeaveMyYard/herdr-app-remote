import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";

beforeEach(() => {
  window.location.hash = "";
});

describe("diagnostics overlay", () => {
  it("stays hidden until the title is tapped 5 times, then lists the fields and closes", async () => {
    render(<App />);
    const title = screen.getAllByText("Herdr")[0]!;
    for (let i = 0; i < 4; i++) await userEvent.click(title);
    expect(screen.queryByRole("dialog", { name: "Diagnostics" })).toBeNull();
    await userEvent.click(title);
    const dialog = screen.getByRole("dialog", { name: "Diagnostics" });
    for (const label of [
      "navigator.standalone",
      "display-mode: standalone",
      "devicePixelRatio",
      "innerWidth x innerHeight",
      "outerHeight",
      "documentElement.clientHeight",
      "visualViewport offsetTop",
      "visualViewport pageTop",
      "inset top",
      "inset bottom",
      "html",
      "body",
      "#root",
      ".ph",
      ".app-header",
      ".screen",
      ".tabbar",
      ".tabbar padding-bottom",
      "userAgent",
    ]) {
      expect(dialog).toHaveTextContent(label);
    }
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Diagnostics" })).toBeNull();
  });
});
