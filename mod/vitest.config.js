// The mod imports herdr-app's host modules; tests map them to the shim in test/shim.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shim = (f) => fileURLToPath(new URL(`./test/shim/${f}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^herdr$/, replacement: shim('herdr.js') },
      { find: /^gpui-kit$/, replacement: shim('gpui.js') },
      { find: /^gpui-base$/, replacement: shim('gpui.js') },
      { find: /^net$/, replacement: shim('net.js') },
      { find: /^fs\/promises$/, replacement: shim('fs.js') },
    ],
  },
  test: { include: ['test/**/*.test.js'] },
});
