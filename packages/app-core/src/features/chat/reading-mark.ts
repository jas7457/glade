/**
 * Highlights a range of a markdown block's source in its rendered tree (I-193: the word being read
 * aloud, see state/reading-highlight.ts): a rehype step that wraps the text covering [start, end)
 * in `<mark data-reading>`. Text nodes carry their source positions; where a node's text isn't the
 * source character for character (inline code with its backticks, entities, escapes) the whole
 * node is wrapped. Code blocks (`pre`) are left alone.
 */

/** The bits of hast this needs (no dependency on @types/hast). */
interface HastText {
  type: "text";
  value: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}
interface HastParent {
  type: string;
  children?: HastNode[];
}
type HastNode = HastText | HastElement | (HastParent & { type: "root" | "comment" | "doctype" | "raw" });

function mark(children: HastNode[]): HastElement {
  return { type: "element", tagName: "mark", properties: { dataReading: "", className: ["pi-md-reading"] }, children };
}

/** Wraps the text of `tree` covering [start, end) (offsets in the block's markdown). Mutates `tree`. */
export function markRange(tree: HastParent, start: number, end: number): void {
  const walk = (parent: HastParent) => {
    const children = parent.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!;
      if (node.type === "element") {
        if (node.tagName !== "pre") walk(node);
        continue;
      }
      if (node.type !== "text") continue;
      const a = node.position?.start.offset;
      const z = node.position?.end.offset;
      if (a === undefined || z === undefined || z <= start || a >= end) continue;
      if (z - a !== node.value.length) {
        children[i] = mark([node]);
        continue;
      }
      const from = Math.max(start, a) - a;
      const to = Math.min(end, z) - a;
      const parts: HastNode[] = [];
      if (from > 0) parts.push({ type: "text", value: node.value.slice(0, from) });
      parts.push(mark([{ type: "text", value: node.value.slice(from, to) }]));
      if (to < node.value.length) parts.push({ type: "text", value: node.value.slice(to) });
      children.splice(i, 1, ...parts);
      i += parts.length - 1;
    }
  };
  walk(tree);
}

/**
 * The rehype plugin marking [start, end), used as `[rehypeReadingMark, { start, end }]`: Streamdown
 * caches processors by plugin name + options, so the range must be in the options.
 */
export function rehypeReadingMark(options: { start: number; end: number }) {
  return (tree: HastParent) => markRange(tree, options.start, options.end);
}

/**
 * Where each of Streamdown's blocks starts in `text` (its blocks are consecutive slices of the
 * markdown). `blocks` from `parseMarkdownIntoBlocks`; a block that doesn't line up is searched for.
 */
export function blockStarts(text: string, blocks: readonly string[]): number[] {
  const starts: number[] = [];
  let pos = 0;
  for (const block of blocks) {
    const at = text.startsWith(block, pos) ? pos : text.indexOf(block, pos);
    const start = at < 0 ? pos : at;
    starts.push(start);
    pos = start + block.length;
  }
  return starts;
}
