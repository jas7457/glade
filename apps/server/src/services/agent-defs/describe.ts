/**
 * "Write description for me" (I-218): a one-shot prompt for the quick-tasks model that turns an
 * agent's name and prompt into a trigger-style description ("Use when…, not for…"), which only the
 * orchestrator reads when it picks an agent.
 */
import { MAX_AGENT_DEF_DESCRIPTION, type DescribeAgentDefRequest } from "@glade/protocol";
import { harnessLabel } from "./fields.js";

/** Prompt text kept short: the agent's prompt is cut at this length. */
const MAX_PROMPT_CHARS = 8_000;

export function describePrompt(req: DescribeAgentDefRequest): string {
  const prompt = req.prompt.trim().slice(0, MAX_PROMPT_CHARS);
  const harness = req.harness && req.harness !== "inherit" ? ` It runs on ${harnessLabel(req.harness)}.` : "";
  return [
    `You write the description of a sub-agent named "${req.name}".${harness} An orchestrating agent reads only this description to decide when to start this sub-agent.`,
    "Write one or two short sentences in the style of a trigger: start with \"Use when\" (what kind of task it's for), then \"not for\" (what to use something else for). Mention if it only reads and never edits, when the instructions say so.",
    "Reply with the description only: no quotes, no heading, no preamble.",
    "",
    "The sub-agent's instructions:",
    "<<<",
    prompt || "(none yet)",
    ">>>",
  ].join("\n");
}

/** The model's reply as a description (quotes/labels stripped, one paragraph, length-capped). */
export function cleanDescription(reply: string): string {
  let text = reply.trim();
  text = text.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  text = text.replace(/^(description|answer)\s*:\s*/i, "").trim();
  if (/^["'“].*["'”]$/s.test(text)) text = text.slice(1, -1).trim();
  text = text.replace(/\s*\n+\s*/g, " ");
  return text.slice(0, MAX_AGENT_DEF_DESCRIPTION).trim();
}
