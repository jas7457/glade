/**
 * Markdown rendering for the transcript: Streamdown (tolerates incomplete markdown while
 * streaming) + @streamdown/code (Shiki highlighting), restyled to our tokens in markdown.css.
 *
 * Memoized on its props, so completed messages never re-render while another one streams.
 * Streamdown additionally memoizes per markdown block, so a streaming message only re-parses
 * its last block.
 *
 * `highlight` marks a range of the markdown (I-193: the word being read aloud): only the block
 * holding it is rendered again, with a rehype step that wraps that range (reading-mark.ts).
 */
import { createContext } from "preact";
import { memo, useContext, useMemo } from "preact/compat";
import { Block, parseMarkdownIntoBlocks, Streamdown, type BlockProps, type ControlsConfig, type PluginConfig } from "streamdown";

/** One entry of Streamdown's `rehypePlugins`. */
type Pluggable = NonNullable<BlockProps["rehypePlugins"]>[number];
import { code } from "@streamdown/code";
import { cn } from "@glade/app-core/lib/cn";
import { blockStarts, rehypeReadingMark } from "./reading-mark";
import "./markdown.css";

export interface MarkdownProps {
  text: string;
  /** The text is still growing: completes unterminated syntax and animates. */
  streaming?: boolean;
  /** Compact code blocks without header chrome (used inside tool bodies). */
  bare?: boolean;
  /** Max height of fenced code blocks (px). */
  codeMaxHeight?: number;
  class?: string;
  /** [start, end) of `text` to highlight (the word being read aloud, I-193). */
  highlight?: [number, number] | null;
}

const plugins: PluginConfig = { code };
const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
};
const linkSafety = { enabled: false };

/** The highlight and where each block starts, for `ReadingBlock`. */
const ReadingContext = createContext<{ starts: number[]; range: [number, number] } | null>(null);

/** Streamdown's block, with the highlight's rehype step when the highlight is in it. */
function ReadingBlock(props: BlockProps) {
  const reading = useContext(ReadingContext);
  const start = reading?.starts[props.index];
  if (!reading || start === undefined || reading.range[1] <= start || reading.range[0] >= start + props.content.length) return <Block {...props} />;
  const mark: Pluggable = [rehypeReadingMark, { start: reading.range[0] - start, end: reading.range[1] - start }];
  return <Block {...props} rehypePlugins={[...(props.rehypePlugins ?? []), mark]} />;
}

export const Markdown = memo(function Markdown({ text, streaming = false, bare = false, codeMaxHeight = 480, class: className, highlight = null }: MarkdownProps) {
  const from = highlight?.[0];
  const to = highlight?.[1];
  const starts = useMemo(() => (from === undefined ? null : blockStarts(text, parseMarkdownIntoBlocks(text))), [text, from === undefined]);
  const reading = useMemo(() => (starts && from !== undefined && to !== undefined ? { starts, range: [from, to] as [number, number] } : null), [starts, from, to]);
  return (
    <ReadingContext.Provider value={reading}>
      <Streamdown
      className={cn("pi-md selectable", bare && "pi-md-bare", className)}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      plugins={plugins}
      controls={controls}
      linkSafety={linkSafety}
      lineNumbers={false}
      codeBlockMaxHeight={codeMaxHeight}
      BlockComponent={ReadingBlock}
    >
      {text}
    </Streamdown>
    </ReadingContext.Provider>
  );
});

/** Wrap code in a fence that can't be closed by backticks inside the code. */
export function fenced(source: string, language = ""): string {
  const longest = Math.max(2, ...Array.from(source.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${source.replace(/\n$/, "")}\n${fence}`;
}

/** Syntax-highlighted, copyable code block (no markdown around it). */
export function CodeView({ source, language, maxHeight = 360 }: { source: string; language?: string; maxHeight?: number }) {
  return <Markdown bare text={fenced(source, language)} codeMaxHeight={maxHeight} />;
}
