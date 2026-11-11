import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // assetsInlineLimit 0: the planned CSP (default-src 'self') blocks data: URLs, so every asset is a file.
  build: { outDir: "dist", assetsInlineLimit: 0 },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    css: false,
  },
});
