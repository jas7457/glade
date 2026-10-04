/**
 * `Settings.localModels` (I-196): checks a settings patch's model server URL, and the env
 * handed to agent processes so pi's llama.cpp provider finds the same server.
 */
import type { DeepPartial, Settings } from "@glade/protocol";
import { HttpError } from "../app/errors.js";

/** Throws 400 unless `localModels.url` (when present) is an http(s) URL. */
export function validateLocalModelsPatch(patch: DeepPartial<Settings>): void {
  const lm = (patch as { localModels?: unknown })?.localModels;
  if (lm === undefined) return;
  if (typeof lm !== "object" || lm === null || Array.isArray(lm)) throw new HttpError(400, "localModels must be an object");
  const url = (lm as { url?: unknown }).url;
  if (url === undefined) return;
  if (typeof url !== "string" || !isHttpUrl(url)) throw new HttpError(400, "localModels.url must be an http:// or https:// URL");
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `LLAMA_BASE_URL` for agent processes (pi's llama.cpp provider): the configured URL, unless the
 * server's own environment already sets it (then that one is inherited as is).
 */
export function llamaBaseUrlEnv(url: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return env.LLAMA_BASE_URL ? {} : { LLAMA_BASE_URL: url.trim() };
}
