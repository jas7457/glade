/**
 * Tool renderer registry: per tool name, an icon and an expanded body. To support a new tool,
 * add an entry here (and a summarizer in summaries.ts). Unknown tools use the fallback.
 */
import type { ComponentType } from "preact";
import type { ToolCallBlock, ToolResult } from "@pi-ui/protocol";
import { FilePen, FilePlus, FileText, FolderOpen, Search, Terminal, Wrench, type LucideProps } from "lucide-preact";
import { cn } from "@/lib/cn";
import { CodeView } from "../Markdown";
import type { ToolCallStatus } from "../grouping";
import { diffFromEdits, diffStats, editsFromArgs, languageFromPath, parsePiDiff, stripAnsi, type DiffLine } from "./text";

export interface ToolBodyProps {
  call: ToolCallBlock;
  result: ToolResult | undefined;
  status: ToolCallStatus;
}

export interface ToolRenderer {
  icon: ComponentType<LucideProps>;
  Body: ComponentType<ToolBodyProps>;
  /** Optional short detail shown at the right end of the collapsed row (e.g. "+3 −1"). */
  Badge?: ComponentType<ToolBodyProps>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

const panel = "overflow-hidden rounded-[8px] border-[0.5px] border-separator bg-code";

function OutputText({ text, error, class: className }: { text: string; error?: boolean; class?: string }) {
  if (!text) return null;
  return (
    <pre
      class={cn(
        "selectable max-h-72 overflow-auto px-3 py-2 font-mono text-[0.88rem] leading-[1.45] whitespace-pre-wrap break-words",
        error ? "text-danger" : "text-fg-muted",
        className,
      )}
    >
      {stripAnsi(text).replace(/\n+$/, "")}
    </pre>
  );
}

function ResultImages({ result }: { result: ToolResult | undefined }) {
  if (!result?.images?.length) return null;
  return (
    <div class="flex flex-wrap gap-2 p-2">
      {result.images.map((img, i) => (
        <img key={i} src={`data:${img.mimeType};base64,${img.data}`} class="max-h-60 rounded-[6px] border-[0.5px] border-separator" alt="" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------------------------

function BashBody({ call, result, status }: ToolBodyProps) {
  const command = str(call.args?.command) ?? "";
  const output = stripAnsi(result?.output ?? "").replace(/\n+$/, "");
  return (
    <div class={panel}>
      <pre class="selectable max-h-80 overflow-auto px-3 py-2 font-mono text-[0.88rem] leading-[1.45] whitespace-pre-wrap break-words">
        <span class="text-fg">
          <span class="text-fg-subtle">$ </span>
          {command}
        </span>
        {output && <span class="block pt-1 text-fg-muted">{output}</span>}
        {!output && status === "done" && <span class="block pt-1 text-fg-subtle italic">(no output)</span>}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------------------------

function ReadBody({ call, result, status }: ToolBodyProps) {
  if (!result) return null;
  if (status === "error") return <div class={panel}><OutputText text={result.output} error /></div>;
  return (
    <div class={panel}>
      {result.output && <CodeView source={result.output} language={languageFromPath(str(call.args?.path))} />}
      <ResultImages result={result} />
    </div>
  );
}

function WriteBody({ call, result, status }: ToolBodyProps) {
  const content = str(call.args?.content) ?? "";
  return (
    <div class={panel}>
      {status === "error" && result ? <OutputText text={result.output} error /> : null}
      {content ? <CodeView source={content} language={languageFromPath(str(call.args?.path))} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------------------------

function editDiffLines(call: ToolCallBlock, result: ToolResult | undefined): DiffLine[] {
  const details = result?.details as { diff?: unknown } | undefined;
  if (details && typeof details.diff === "string" && details.diff) return parsePiDiff(details.diff);
  return diffFromEdits(editsFromArgs(call.args));
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div class="selectable max-h-96 overflow-auto py-1 font-mono text-[0.88rem] leading-[1.5]">
      {lines.map((l, i) =>
        l.kind === "gap" ? (
          <div key={i} class="px-3 text-fg-subtle">⋯</div>
        ) : (
          <div
            key={i}
            class={cn(
              "flex min-w-fit",
              l.kind === "add" && "bg-success/10",
              l.kind === "del" && "bg-danger/10",
            )}
          >
            <span class="w-10 shrink-0 pr-2 text-right text-fg-subtle select-none">{l.newNo ?? l.oldNo ?? ""}</span>
            <span
              class={cn(
                "w-4 shrink-0 select-none",
                l.kind === "add" ? "text-success" : l.kind === "del" ? "text-danger" : "text-fg-subtle",
              )}
            >
              {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
            </span>
            <span class="pr-3 whitespace-pre">{l.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}

function EditBody({ call, result, status }: ToolBodyProps) {
  const lines = editDiffLines(call, result);
  return (
    <div class={panel}>
      {status === "error" && result && <OutputText text={result.output} error />}
      {lines.length > 0 && <DiffView lines={lines} />}
    </div>
  );
}

function EditBadge({ call, result, status }: ToolBodyProps) {
  if (status === "error" || !call.args) return null;
  const { added, removed } = diffStats(editDiffLines(call, result));
  if (!added && !removed) return null;
  return (
    <span class="font-mono text-[0.85rem]">
      <span class="text-success">+{added}</span> <span class="text-danger">−{removed}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// grep / find / ls / fallback
// ---------------------------------------------------------------------------------------------

function PlainOutputBody({ result, status }: ToolBodyProps) {
  if (!result) return null;
  return (
    <div class={panel}>
      <OutputText text={result.output || (status === "done" ? "(no output)" : "")} error={status === "error"} />
      <ResultImages result={result} />
    </div>
  );
}

function DefaultBody({ call, result, status }: ToolBodyProps) {
  const argsText = call.args ? JSON.stringify(call.args, null, 2) : call.argsText ?? "";
  return (
    <div class={cn(panel, "divide-y-[0.5px] divide-separator")}>
      {argsText && argsText !== "{}" && (
        <pre class="selectable max-h-60 overflow-auto px-3 py-2 font-mono text-[0.88rem] leading-[1.45] whitespace-pre-wrap break-words text-fg">
          {argsText}
        </pre>
      )}
      {result && <OutputText text={result.output} error={status === "error"} />}
      <ResultImages result={result} />
    </div>
  );
}

export const toolRenderers: Record<string, ToolRenderer> = {
  bash: { icon: Terminal, Body: BashBody },
  read: { icon: FileText, Body: ReadBody },
  write: { icon: FilePlus, Body: WriteBody },
  edit: { icon: FilePen, Body: EditBody, Badge: EditBadge },
  grep: { icon: Search, Body: PlainOutputBody },
  find: { icon: Search, Body: PlainOutputBody },
  ls: { icon: FolderOpen, Body: PlainOutputBody },
};

export const fallbackRenderer: ToolRenderer = { icon: Wrench, Body: DefaultBody };

export function rendererFor(name: string): ToolRenderer {
  return toolRenderers[name] ?? fallbackRenderer;
}
