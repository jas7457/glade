/**
 * One-shot Claude Code runs without tools or a saved session (I-173): titles and other
 * completions, and side questions (streamed). Cheap by default: Haiku, thinking off, one turn.
 *
 *   await claudeOneShot({ sdk, executable, env, cwd, prompt, model: "haiku" })  // → text | null
 */
import type { ClaudeOptions, ClaudeSdk, ClaudeWire } from "./sdk.js";

export interface ClaudeOneShotOptions {
  sdk: ClaudeSdk;
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  /** Claude model id or alias. */
  model: string;
  systemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each piece of the answer as it streams. */
  onDelta?: (delta: string) => void;
  log?: (msg: string) => void;
}

export interface ClaudeOneShotResult {
  text: string;
  error?: string;
}

/** Run it; never rejects (failures resolve with `error`, a stop with the partial text). */
export async function claudeOneShot(options: ClaudeOneShotOptions): Promise<ClaudeOneShotResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort);
  const timer = setTimeout(abort, options.timeoutMs ?? 60_000);
  timer.unref?.();
  let text = "";
  let streamed = false;
  try {
    const sdkOptions: ClaudeOptions = {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: options.executable,
      env: { ...options.env, CLAUDE_AGENT_SDK_CLIENT_APP: "glade" },
      model: options.model,
      thinking: { type: "disabled" },
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: !!options.onDelta,
      abortController: controller,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    };
    const query = await options.sdk.query({ prompt: options.prompt, options: sdkOptions });
    let error: string | undefined;
    for await (const message of query as AsyncIterable<ClaudeWire>) {
      if (message.type === "stream_event") {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          streamed = true;
          text += event.delta.text;
          options.onDelta?.(event.delta.text);
        }
      } else if (message.type === "assistant" && !streamed) {
        const content = (message.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
        const part = content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
        if (part) {
          text += part;
          options.onDelta?.(part);
        }
      } else if (message.type === "result") {
        if (message.is_error || message.subtype !== "success") {
          const errors = Array.isArray(message.errors) ? message.errors.join("\n") : "";
          error = errors || (typeof message.result === "string" ? message.result : "") || "Claude Code failed";
        }
        break;
      }
    }
    query.close();
    return error && !controller.signal.aborted ? { text, error } : { text };
  } catch (err) {
    if (controller.signal.aborted) return { text };
    options.log?.(`claude one-shot failed: ${(err as Error).message}`);
    return { text, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
