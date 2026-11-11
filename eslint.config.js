import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
);
