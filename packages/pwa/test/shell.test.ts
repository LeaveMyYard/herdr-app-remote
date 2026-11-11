import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "../src/sw-register";

const pwa = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(pwa, p), "utf8");

describe("manifest and icons", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
    display: string;
    start_url: string;
    scope: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };

  it("installs standalone with relative start_url and scope", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
  });

  it("ships 192, 512 and maskable icons that exist", () => {
    const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const i of manifest.icons) expect(existsSync(resolve(pwa, "public", i.src)), i.src).toBe(true);
  });

  it("has an apple touch icon, status-bar style and viewport-fit=cover in index.html", () => {
    const html = read("index.html");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain("black-translucent");
    expect(existsSync(resolve(pwa, "public/icons/apple-touch-icon.png"))).toBe(true);
  });
});

describe("safe areas", () => {
  const css = read("src/styles/app.css");
  it("uses the device insets when installed, and the design's insets otherwise", () => {
    expect(css).toMatch(/display-mode: standalone[\s\S]*env\(safe-area-inset-top\)/);
    expect(css).toMatch(/display-mode: standalone[\s\S]*env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/--sat:50px/);
    expect(css).toMatch(/--sab:30px/);
    expect(css).toMatch(/\.app-header\{[^}]*var\(--sat\)/);
    expect(css).toMatch(/\.status-spacer\{[^}]*var\(--sat\)/);
    expect(css).toMatch(/\.tabbar\{[^}]*var\(--sab\)/);
  });
});

describe("no network at runtime", () => {
  it("the shell never references a remote origin", () => {
    const files = ["index.html", "public/manifest.webmanifest", "public/sw.js", "src/styles/fonts.css", "src/styles/app.css"];
    for (const f of files) {
      const text = read(f).replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "");
      expect(text, f).not.toMatch(/https?:\/\//);
    }
  });

  it("fonts are local woff2 files", () => {
    const css = read("src/styles/fonts.css");
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/\.woff2$/);
      expect(existsSync(resolve(pwa, "src/styles", u)), u).toBe(true);
    }
  });

  it("licences for the bundled fonts are listed", () => {
    const notice = read("THIRD-PARTY.md");
    for (const name of ["Inter", "JetBrains Mono", "OFL-1.1"]) expect(notice).toContain(name);
    expect(readdirSync(pwa)).toContain("THIRD-PARTY.md");
  });
});

describe("registerServiceWorker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("registers the worker in production once the page has loaded", () => {
    const register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });
    registerServiceWorker({ prod: true });
    expect(register).toHaveBeenCalledWith("./sw.js");
  });

  it("does nothing outside production", () => {
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });
    registerServiceWorker({ prod: false });
    expect(register).not.toHaveBeenCalled();
  });

  it("swallows a failed registration", async () => {
    const register = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });
    expect(() => registerServiceWorker({ prod: true })).not.toThrow();
    await Promise.resolve();
  });
});
