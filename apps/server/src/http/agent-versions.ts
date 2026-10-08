/**
 * Agent versions and updates routes (I-198, `@glade/protocol` `agent-versions.ts`):
 *
 *   GET  /agent-versions                         → AgentVersionsStatus
 *   POST /agent-versions/check[?force=1]         → AgentVersionsStatus (answers when the check is done;
 *                                                  without `force` a check from the last 10 min is reused)
 *   POST /agent-versions/:harness/update         → AgentVersionsStatus (starts or queues it)
 *   POST /agent-versions/:harness/update/cancel  → AgentVersionsStatus (only while waiting)
 *
 * Not host-only: paired devices read and start updates on this Mac, like Local Models. Errors:
 * 404 unknown agent, 409 one runs / waits already, the agent can't be updated, nothing to cancel.
 *
 * {@link agentCommandRoutes} (I-201, host only: it runs a command typed in the field):
 *
 *   POST /agent-command/test  { harness, command } → AgentCommandTestResult (`<command> --version`)
 */
import { Hono, type Context } from "hono";
import type { AgentCommandTestRequest, AgentVersionsStatus } from "@glade/protocol";
import { AgentVersionsError, type AgentVersionsService } from "../services/agent-versions/service.js";
import { testAgentCommand } from "../services/agent-versions/versions.js";

export function agentVersionsRoutes(versions: AgentVersionsService): Hono {
  const api = new Hono();

  api.get("/agent-versions", (c) => c.json(versions.status()));

  api.post("/agent-versions/check", async (c) => {
    const force = c.req.query("force");
    return c.json(await versions.check({ force: force === "1" || force === "true" }));
  });

  api.post("/agent-versions/:harness/update", (c) => act(c, () => versions.startUpdate(c.req.param("harness"))));
  api.post("/agent-versions/:harness/update/cancel", (c) => act(c, () => versions.cancelUpdate(c.req.param("harness"))));

  return api;
}

/** The agent page's Test button (I-201). Mount behind `localOnly`. */
export function agentCommandRoutes(test: typeof testAgentCommand = testAgentCommand): Hono {
  const api = new Hono();
  api.post("/agent-command/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<AgentCommandTestRequest> | null;
    if (!body || typeof body.harness !== "string" || !body.harness || typeof body.command !== "string") {
      return c.json({ error: "Expected { harness, command }." }, 400);
    }
    return c.json(await test(body.harness, body.command));
  });
  return api;
}

function act(c: Context, fn: () => AgentVersionsStatus): Response {
  try {
    return c.json(fn());
  } catch (err) {
    if (err instanceof AgentVersionsError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}
