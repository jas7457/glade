/**
 * The server's "Quit the older Glade first" state (I-121): while a Glade from before the database
 * runs on the same data folder, this minimal server answers on the port instead of the app.
 * Pages show the message and reload once the real server is up; API calls answer 503 with it
 * (`GET /api/settings` answers 200 with the defaults so the desktop app still opens its window
 * and shows the page instead of timing out). Nothing touches the data folder meanwhile.
 */
import { createServer, type Server } from "node:http";
import { defaultSettings } from "@glade/protocol";

export const BLOCKED_STATUS_PATH = "/api/startup/blocked";

function page(message: string): string {
  const escaped = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Glade</title>
<style>
  :root { color-scheme: light dark; font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 440px; padding: 24px; text-align: center; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  p { margin: 0 0 8px; opacity: .8; line-height: 1.45; }
</style></head>
<body><main>
  <h1>Quit the older Glade first</h1>
  <p>${escaped}</p>
  <p>This page continues on its own once it has quit.</p>
</main>
<script>
  setInterval(async () => {
    try {
      const res = await fetch(${JSON.stringify(BLOCKED_STATUS_PATH)}, { cache: "no-store" });
      if (res.status !== 503) location.reload();
    } catch {}
  }, 1500);
</script>
</body></html>`;
}

export interface BlockedServer {
  close(): Promise<void>;
  setMessage(message: string): void;
}

export function startBlockedServer(host: string, port: number, message: string, onListening?: (port: number) => void): BlockedServer {
  let current = message;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/settings" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(defaultSettings()));
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: current, code: "older_server" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page(current));
  });
  server.listen(port, host, () => {
    const address = server.address();
    onListening?.(typeof address === "object" && address ? address.port : port);
  });
  return {
    setMessage(message) {
      current = message;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
