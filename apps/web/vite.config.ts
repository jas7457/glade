import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const serverPort = Number(process.env.PI_UI_PORT ?? 4317);
// Sandboxes (`pnpm dev:agent`) run Vite on their own port; the user's `pnpm dev` keeps 5317.
const webPort = Number(process.env.PI_UI_WEB_PORT ?? 5317);

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});
