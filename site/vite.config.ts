// The public website (I-209): a static page built for GitHub Pages under /glade/.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { mediaPlugin } from "./build/vite-media-plugin.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "/glade/",
  plugins: [mediaPlugin(root)],
  server: { host: "127.0.0.1", port: 5417, strictPort: false },
  preview: { host: "127.0.0.1", port: 5418, strictPort: false },
  build: { target: "es2022", assetsInlineLimit: 0 },
});
