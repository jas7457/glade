/**
 * Tool renderer registry: per canonical tool kind (I-068), an icon and an expanded body. Bodies
 * read only the normalized `call.input` / `result.diff`; `other` tools use the fallback, which
 * shows the harness's raw args. A new kind needs an entry here and a summarizer in summaries.ts.
 */
import type { ComponentType } from "preact";
import type { DiffLine, ToolCallBlock, ToolKind, ToolResult } from "@glade/protocol";
import { Bot, FilePen, FilePlus, FileText, FolderOpen, Globe, History, MessagesSquare, Plug, Search, Terminal, Wrench, type LucideProps } from "lucide-preact";
import { cn } from "@/lib/cn";
import { CodeView, Markdown } from "../Markdown";
import { imageSrc, useImageLightbox } from "../ImageLightbox";
import type { ToolCallStatus } from "../grouping";
import { diffFromEdits, diffStats, languageFromPath, stripAnsi } from "./text";

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
  // Click opens the image large (I-110).
  const { open, lightbox } = useImageLightbox(result?.images ?? NO_IMAGES);
  if (!result?.images?.length) return null;
  return (
    <div class="flex flex-wrap gap-2 p-2">
      {result.images.map((img, i) => (
        <button key={i} type="button" aria-label="Open image" onClick={() => open(i)} class="flex min-w-0 max-w-full cursor-zoom-in rounded-[6px] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent">
          <img src={imageSrc(img)} class="h-auto max-h-60 min-w-0 max-w-full rounded-[6px] object-contain border-[0.5px] border-separator" alt="" />
        </button>
      ))}
      {lightbox}
    </div>
  );
}

const NO_IMAGES: never[] = [];

// ---------------------------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------------------------

function ShellBody({ call, result, status }: ToolBodyProps) {
  const command = call.input?.command ?? "";
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
      {result.output && <CodeView source={result.output} language={languageFromPath(call.input?.path)} />}
      <ResultImages result={result} />
    </div>
  );
}

function WriteBody({ call, result, status }: ToolBodyProps) {
  const content = call.input?.content ?? "";
  return (
    <div class={panel}>
      {status === "error" && result ? <OutputText text={result.output} error /> : null}
      {content ? <CodeView source={content} language={languageFromPath(call.input?.path)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------------------------

/** The harness's diff once the edit ran, else a preview built from the requested edits. */
function editDiffLines(call: ToolCallBlock, result: ToolResult | undefined): DiffLine[] {
  if (result?.diff?.length) return result.diff;
  return diffFromEdits(call.input?.edits ?? []);
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div class="selectable max-h-96 overflow-auto py-1 font-mono text-[0.88rem] leading-[1.5]">
      {lines.map((l, i) =>
        l.type === "gap" ? (
          <div key={i} class="px-3 text-fg-subtle">⋯</div>
        ) : (
          <div
            key={i}
            class={cn(
              "flex min-w-fit",
              l.type === "add" && "bg-success/10",
              l.type === "del" && "bg-danger/10",
            )}
          >
            <span class="w-10 shrink-0 pr-2 text-right text-fg-subtle select-none">{l.newLine ?? l.oldLine ?? ""}</span>
            <span
              class={cn(
                "w-4 shrink-0 select-none",
                l.type === "add" ? "text-success" : l.type === "del" ? "text-danger" : "text-fg-subtle",
              )}
            >
              {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
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
  if (status === "error" || call.args === undefined) return null;
  const { added, removed } = diffStats(editDiffLines(call, result));
  if (!added && !removed) return null;
  return (
    <span class="font-mono text-[0.85rem]">
      <span class="text-success">+{added}</span> <span class="text-danger">−{removed}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// search / list / web / task / fallback
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

/** message_agent: the message as Markdown (not JSON), then the tool's result (I-108). */
function AgentBody(props: ToolBodyProps) {
  const text = typeof props.call.args?.text === "string" ? props.call.args.text : null;
  if (!text) return <DefaultBody {...props} />;
  const { result, status } = props;
  return (
    <div class={cn(panel, "divide-y-[0.5px] divide-separator")}>
      <Markdown text={text} class="selectable px-3 py-2" />
      {result && <OutputText text={result.output} error={status === "error"} />}
    </div>
  );
}

export const fallbackRenderer: ToolRenderer = { icon: Wrench, Body: DefaultBody };

export const toolRenderers: Record<ToolKind, ToolRenderer> = {
  shell: { icon: Terminal, Body: ShellBody },
  read: { icon: FileText, Body: ReadBody },
  write: { icon: FilePlus, Body: WriteBody },
  edit: { icon: FilePen, Body: EditBody, Badge: EditBadge },
  search: { icon: Search, Body: PlainOutputBody },
  list: { icon: FolderOpen, Body: PlainOutputBody },
  web: { icon: Globe, Body: PlainOutputBody },
  task: { icon: Bot, Body: PlainOutputBody },
  // Agent messages and MCP calls show their args too (the message text, the tool's arguments).
  agent: { icon: MessagesSquare, Body: AgentBody },
  mcp: { icon: Plug, Body: DefaultBody },
  // Chat tools (I-099): the found chats / read messages / confirmation.
  chat: { icon: History, Body: PlainOutputBody },
  other: fallbackRenderer,
};

/** Renderer for a kind; kinds this build doesn't know render like `other`. */
export function rendererFor(kind: ToolKind): ToolRenderer {
  return (toolRenderers as Partial<Record<string, ToolRenderer>>)[kind] ?? fallbackRenderer;
}
