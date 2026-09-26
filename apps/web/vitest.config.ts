import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // Use react-router's ESM build: under Node's "node" condition it resolves to CJS, which
      // requires preact's CJS build and ends up with two preact instances (hooks break).
      { find: /^react-router$/, replacement: fileURLToPath(new URL("./node_modules/react-router/dist/development/index.mjs", import.meta.url)) },
      // Same problem for Radix's dependencies: force every "react" import onto preact/compat's ESM.
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
    ],
    // Prefer ESM builds (react-remove-scroll & co. ship CJS in "main").
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Radix (and react-router) must go through Vite so "react" resolves to the same preact/compat
    // instance as the app; otherwise hooks run against a second preact copy.
    server: { deps: { inline: ["react-router", /@radix-ui\//, /@floating-ui\/react/, /react-remove-scroll/, /react-style-singleton/, /use-callback-ref/, /use-sidecar/, /aria-hidden/] } },
  },
});
