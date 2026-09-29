import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

const web = (p: string) => fileURLToPath(new URL(`../web/${p}`, import.meta.url));

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: [
      { find: "@", replacement: web("src") },
      { find: "~", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // Same ESM/one-preact setup as apps/web/vitest.config.ts.
      { find: /^react-router$/, replacement: web("node_modules/react-router/dist/development/index.mjs") },
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
    ],
    mainFields: ["module", "jsnext:main", "jsnext"],
    dedupe: ["preact", "@preact/signals"],
  },
  test: {
    name: "iphone",
    environment: "jsdom",
    setupFiles: [web("src/test/setup.ts")],
    css: false,
    server: { deps: { inline: ["react-router", /@radix-ui\//, /@floating-ui\/react/, /react-remove-scroll/, /react-style-singleton/, /use-callback-ref/, /use-sidecar/, /aria-hidden/] } },
  },
});
