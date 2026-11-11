import js from "@eslint/js";
import tseslint from "typescript-eslint";

const timers = { setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly" };

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "design/**", "rig/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The service worker runs in ServiceWorkerGlobalScope.
    files: ["packages/pwa/public/sw.js"],
    languageOptions: {
      globals: { self: "readonly", caches: "readonly", fetch: "readonly", URL: "readonly", Response: "readonly" },
    },
  },
  {
    // Runs inside herdr-app: no setTimeout/setInterval there (cx.timer instead), so they stay undefined.
    files: ["mod/herdr-app-remote/**/*.js"],
    languageOptions: { globals: { console: "readonly" } },
  },
  {
    files: ["mod/test/**/*.js", "mod/vitest.config.js"],
    languageOptions: { globals: { ...timers, console: "readonly", URL: "readonly", process: "readonly" } },
  },
);
