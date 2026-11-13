import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Another checkout may hold 4173: PW_PORT picks this one's own preview port.
const port = process.env.PW_PORT ?? "4173";
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 };

export default defineConfig({
  testDir: "visual",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    command: `pnpm run build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: "dark", timezoneId: "UTC" },
  projects: [
    { name: "chromium-phone", use: { ...devices["Desktop Chrome"], ...phone, launchOptions: { args: ["--font-render-hinting=slight"], env: { ...process.env, FONTCONFIG_FILE: resolve(import.meta.dirname, "visual/fonts.conf") } as Record<string, string> } } },
    { name: "webkit-phone", use: { ...devices["Desktop Safari"], ...phone } },
  ],
});
