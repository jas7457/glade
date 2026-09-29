/**
 * Vite / Vitest settings every consumer of the app core shares (apps/web, apps/iphone and this
 * package's own tests), so they all resolve `@glade/app-core/<path>` and one copy of
 * preact / signals / react-router.
 *
 * Import convention: `@glade/app-core/<path under src>` (e.g. `@glade/app-core/state/store`,
 * `@glade/app-core/ui`), an alias to `src/` here and a `paths` entry in each tsconfig. Inside the
 * package, files in the same area use relative imports.
 */
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** `@glade/app-core/…` → packages/app-core/src/…. */
export const appCoreAlias = { find: "@glade/app-core", replacement: here("./src") };

/** Packages whose own copy of preact must not load twice across the apps and the core. */
export const dedupe = ["preact", "@preact/signals", "react-router"];

/** Test setup (cleanup, jsdom polyfills) for every jsdom project. */
export const testSetupFile = here("./src/test/setup.ts");

/**
 * Test-only aliases. Use react-router's ESM build: under Node's "node" condition it resolves to
 * CJS, which requires preact's CJS build and ends up with two preact instances (hooks break).
 * Same problem for Radix's dependencies: force every "react" import onto preact/compat's ESM.
 */
export const testAliases = [
  appCoreAlias,
  { find: /^react-router$/, replacement: here("./node_modules/react-router/dist/development/index.mjs") },
  { find: /^react$/, replacement: "preact/compat" },
  { find: /^react-dom$/, replacement: "preact/compat" },
  { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
];

/**
 * Radix (and react-router) must go through Vite in tests so "react" resolves to the same
 * preact/compat instance as the app; otherwise hooks run against a second preact copy.
 */
export const testInlineDeps = ["react-router", /@radix-ui\//, /@floating-ui\/react/, /react-remove-scroll/, /react-style-singleton/, /use-callback-ref/, /use-sidecar/, /aria-hidden/];
