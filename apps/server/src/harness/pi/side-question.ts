/**
 * Side questions for pi (I-140): a throwaway `pi -p --mode json` process, separate from the
 * chat's RPC process (which is never touched):
 *
 *   pi -p --mode json --no-session --no-tools --no-skills --no-context-files --no-prompt-templates
 *      --system-prompt <side-question prompt> [--model p/id --thinking off]
 *
 * The prompt (the serialized conversation + the question) goes in on stdin (pi prepends piped
 * stdin to the message; no argv size limit). No session file is written and no tool can run.
 * Extensions stay on (they may provide the provider/auth; see `one-shot.ts`). The answer streams
 * from `message_update` `text_delta` events; the final `message_end` is authoritative. Stop =
 * SIGTERM. One model request per question: input = the context sent (up to ~25k tokens), output =
 * the answer; no prompt cache is shared with the chat.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { modelKey } from "@glade/protocol";
import type { SideQuestionCall, SideQuestionResult } from "../types.js";
import { piChildEnv } from "./child-env.js";
import { JsonlSplitter } from "./rpc-process.js";

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface PiSideQuestionOptions extends SideQuestionCall {
  piPath: string;
  /** Injectable for tests (default: `child_process.spawn`). */
  spawn?: SpawnFn;
  /** Overall limit (default 3 minutes). */
  timeoutMs?: number;
  /** Extra environment for the pi process (e.g. `LLAMA_BASE_URL`, I-196). */
  env?: Record<string, string>;
  log?: (msg: string) => void;
}

export function sideQuestionArgs(systemPrompt: string, model: SideQuestionCall["model"]): string[] {
  const args = ["-p", "--mode", "json", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--no-prompt-templates"];
  args.push("--system-prompt", systemPrompt);
  if (model) args.push("--model", modelKey(model), "--thinking", "off");
  return args;
}

interface PiJsonEvent {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
}

function finalText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("");
}

/** Run one side question. Never rejects: failures resolve with `error`, a stop with the partial answer. */
export function piSideQuestion(options: PiSideQuestionOptions): Promise<SideQuestionResult> {
  const { piPath, prompt, systemPrompt, model, cwd, signal, onDelta, log } = options;
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  return new Promise<SideQuestionResult>((resolve) => {
    let answer = "";
    let final: string | null = null;
    let error: string | null = null;
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    const finish = (result: SideQuestionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      child?.kill("SIGTERM");
      finish({ answer });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGTERM");
      finish({ answer, error: "The side question timed out" });
    }, options.timeoutMs ?? 180_000);
    timer.unref();
    try {
      child = spawn(piPath, sideQuestionArgs(systemPrompt, model), { cwd, env: piChildEnv(process.env, options.env) });
    } catch (err) {
      finish({ answer: "", error: `Could not start pi: ${(err as Error).message}` });
      return;
    }
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    const splitter = new JsonlSplitter((line) => {
      let event: PiJsonEvent;
      try {
        event = JSON.parse(line) as PiJsonEvent;
      } catch {
        return; // not JSON (an extension printing to stdout)
      }
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta ?? "";
        if (delta && !settled) {
          answer += delta;
          onDelta(delta);
        }
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        final = finalText(event.message.content) ?? final;
        if (event.message.stopReason === "error") error = event.message.errorMessage || "The model returned an error";
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (err) => finish({ answer, error: `Could not start pi: ${err.message}` }));
    child.on("close", (code) => {
      splitter.end();
      if (settled) return;
      const text = final ?? answer;
      if (error) return finish({ answer: text, error });
      if (code !== 0 && !text) {
        const detail = stderr.trim().split("\n").slice(-3).join("\n");
        log?.(`side question failed (exit ${code}): ${detail}`);
        return finish({ answer: text, error: detail || `pi exited with code ${code}` });
      }
      finish({ answer: text });
    });
    child.stdin?.on("error", () => {}); // the process may exit before reading everything
    child.stdin?.end(prompt);
  });
}
