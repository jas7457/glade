#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { runHttpCheck } from "./checks/http.js";
import { Scheduler } from "./checks/scheduler.js";
import { loadConfig } from "./config.js";
import { createNotifier } from "./notify/index.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";

const [command, ...args] = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};

if (command === "serve") {
  const config = loadConfig(flag("config", "lantern.config.json"));
  const store = new Store(config.dbPath);
  const scheduler = new Scheduler(config.checks, store, createNotifier(config.notify));
  scheduler.start();
  setInterval(() => store.prune(), 3_600_000).unref();
  serve({ fetch: createServer(config, store).fetch, port: config.port });
  console.log(`lantern: watching ${config.checks.length} checks, dashboard on http://localhost:${config.port}`);
} else if (command === "check" && args[0]) {
  const result = await runHttpCheck({ id: "adhoc", name: args[0], url: args[0], intervalSec: 0, timeoutMs: 10_000 });
  console.log(result.ok ? `up   ${result.status} ${result.latencyMs} ms` : `down ${result.error ?? result.status}`);
  process.exitCode = result.ok ? 0 : 1;
} else {
  console.log("usage: lantern serve [--config file] | lantern check <url>");
  process.exitCode = 2;
}
