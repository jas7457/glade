/**
 * Glade agents routes (I-218, `@glade/protocol` `agent-defs.ts`), for Settings → Sub-agents:
 *
 *   GET    /agent-defs[?projectId=]                    → ListAgentDefsResponse (project agents too with a project)
 *   PUT    /agent-defs                                 SaveAgentDefRequest → SaveAgentDefResponse
 *   DELETE /agent-defs?scope=&name=[&projectId=]       → 204
 *   POST   /agent-defs/describe                        DescribeAgentDefRequest → DescribeAgentDefResponse
 *   GET    /agent-defs/tools?harness=[&projectId=]     → AgentDefToolsResponse
 *
 * Like other device settings (I-155), paired devices read but don't change: PUT, DELETE and
 * describe (which spends the host's quick-tasks model) answer 403 `local_only` for them. Clients
 * reach another device's agents by calling these routes on that environment's base URL (each
 * environment is its own server with its own agents; there's no proxying).
 *
 * Errors: 400 bad body/fields or a project scope without a folder (group projects, I-213),
 * 404 unknown project / agent, 409 rename onto an existing name, 501 no quick-tasks model.
 */
import { Hono, type Context } from "hono";
import type { AgentDefScope, DescribeAgentDefRequest, ListAgentDefsResponse, SaveAgentDefRequest, SaveAgentDefResponse } from "@glade/protocol";
import { HttpError, type AppService } from "../services/app-service.js";
import { cleanDescription, describePrompt } from "../services/agent-defs/describe.js";
import { isLocal } from "./security.js";

export function agentDefsRoutes(service: AppService): Hono {
  const api = new Hono();

  api.get("/agent-defs", async (c) => {
    const scope = service.agentDefsScope(c.req.query("projectId") || null);
    const agents = await service.agentDefs.list(scope, service.agentDefsContext());
    return c.json({ agents } satisfies ListAgentDefsResponse);
  });

  api.put("/agent-defs", async (c) => {
    const denied = hostOnly(c, service);
    if (denied) return denied;
    const body = await readBody<SaveAgentDefRequest>(c);
    const projectDir = projectFolder(service, body.scope, body.projectId ?? null);
    const agent = await service.agentDefs.save(body, projectDir, service.agentDefsContext());
    return c.json({ agent } satisfies SaveAgentDefResponse);
  });

  api.delete("/agent-defs", async (c) => {
    const denied = hostOnly(c, service);
    if (denied) return denied;
    const scope = c.req.query("scope") as AgentDefScope | undefined;
    const name = c.req.query("name");
    if (scope !== "personal" && scope !== "project") throw new HttpError(400, 'scope must be "personal" or "project"');
    if (!name) throw new HttpError(400, "name is required");
    await service.agentDefs.remove(scope, name, projectFolder(service, scope, c.req.query("projectId") || null));
    return c.body(null, 204);
  });

  api.post("/agent-defs/describe", async (c) => {
    const denied = hostOnly(c, service);
    if (denied) return denied;
    const body = await readBody<DescribeAgentDefRequest>(c);
    if (typeof body.name !== "string" || typeof body.prompt !== "string") throw new HttpError(400, "Expected { name, harness, prompt }");
    if (!body.prompt.trim()) throw new HttpError(400, "Write the prompt first");
    const reply = await service.completeQuickAnywhere(describePrompt({ name: body.name, harness: typeof body.harness === "string" ? body.harness : "", prompt: body.prompt }));
    if (reply === null) throw new HttpError(501, "No quick-tasks model is available on this device");
    const description = cleanDescription(reply);
    if (!description) throw new HttpError(500, "The model returned no description");
    return c.json({ description });
  });

  api.get("/agent-defs/tools", (c) => {
    const harness = c.req.query("harness");
    if (!harness) throw new HttpError(400, "harness is required");
    const projectId = c.req.query("projectId") || null;
    if (projectId) service.agentDefsScope(projectId); // 404 for unknown projects
    return c.json(service.agentDefs.tools(harness, projectId));
  });

  return api;
}

/** 403 for paired devices (I-155: a device's settings change on that device). */
function hostOnly(c: Context, service: AppService): Response | null {
  if (isLocal(c)) return null;
  return c.json({ code: "local_only", error: `Change this on ${service.getEnvironment().name}.` }, 403);
}

/** The project folder for a `project` scope (400 without a project or for a group project); else null. */
function projectFolder(service: AppService, scope: unknown, projectId: string | null): string | null {
  if (scope !== "project") return null;
  if (!projectId) throw new HttpError(400, "projectId is required for project agents");
  const { cwd } = service.agentDefsScope(projectId);
  if (!cwd) throw new HttpError(400, "Group projects have no folder for project agents");
  return cwd;
}

async function readBody<T>(c: Context): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Request body must be a JSON object");
  return body as T;
}
