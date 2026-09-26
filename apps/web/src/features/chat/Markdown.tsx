/**
 * Markdown rendering for the transcript: Streamdown (tolerates incomplete markdown while
 * streaming) + @streamdown/code (Shiki highlighting), restyled to our tokens in markdown.css.
 *
 * Memoized on its props, so completed messages never re-render while another one streams.
 * Streamdown additionally memoizes per markdown block, so a streaming message only re-parses
 * its last block.
 */
import { memo } from "preact/compat";
import { Streamdown, type ControlsConfig, type PluginConfig } from "streamdown";
import { code } from "@streamdown/code";
import { cn } from "@/lib/cn";
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
}

const plugins: PluginConfig = { code };
const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
};
const linkSafety = { enabled: false };

export const Markdown = memo(function Markdown({ text, streaming = false, bare = false, codeMaxHeight = 480, class: className }: MarkdownProps) {
  return (
    <Streamdown
      className={cn("pi-md selectable", bare && "pi-md-bare", className)}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      plugins={plugins}
      controls={controls}
      linkSafety={linkSafety}
      lineNumbers={false}
      codeBlockMaxHeight={codeMaxHeight}
    >
      {text}
    </Streamdown>
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
