/**
 * A small YAML reader/writer for agent frontmatter (I-218). No YAML package is a dependency, and
 * agent files only use a subset, so this covers that subset:
 *
 * - block mappings and sequences by indentation (`key: value`, `- item`, `- key: value` items,
 *   a sequence at its key's indent), nested to any depth;
 * - plain scalars (`null`/`~`, `true`/`false`, numbers, strings; continuation lines folded),
 *   `"double"` (with escapes) and `'single'` quoted strings;
 * - flow collections `[a, b]` / `{ a: 1 }` (nested, may span lines);
 * - block scalars `|` / `>` with chomping (`-`, `+`) and indentation indicators;
 * - `#` comments.
 *
 * Anchors, aliases, tags and multi-document streams aren't supported (they parse as plain text or
 * throw {@link YamlError}). {@link splitTopLevel} keeps each top-level key's raw text so unknown
 * keys survive a save untouched.
 */

export class YamlError extends Error {}

interface Line {
  indent: number;
  /** The text after the indent, comments stripped (raw for block scalars: see `raw`). */
  text: string;
  /** The whole line as written. */
  raw: string;
}

/** Parse a YAML document whose root is a mapping (an empty document = `{}`). */
export function parseYaml(source: string): Record<string, unknown> {
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map(toLine);
  const parser = new BlockParser(lines);
  const first = parser.nextIndex(0);
  if (first < 0) return {};
  const value = parser.parseBlock(first, lines[first]!.indent);
  if (parser.nextIndex(parser.pos) >= 0) throw new YamlError(`Unexpected content on line ${parser.nextIndex(parser.pos) + 1}`);
  if (!isRecord(value)) throw new YamlError("Expected key: value pairs");
  return value;
}

function toLine(raw: string): Line {
  const indent = raw.length - raw.replace(/^ +/, "").length;
  return { indent, text: stripComment(raw.slice(indent)).trimEnd(), raw };
}

/** Text before a `#` comment (a `#` at the start or after whitespace, outside quotes). */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      // Quotes only open a string at a value's start (after `: `, `- `, `[`, `{`, `,` or the line start).
      const before = text.slice(0, i).trimEnd();
      if (before === "" || /[:\-[{,]$/.test(before)) quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i);
    }
  }
  return text;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:,[\]{}][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+|$)/;

class BlockParser {
  pos = 0;
  constructor(private readonly lines: Line[]) {}

  /** The next line from `i` with content, or -1. */
  nextIndex(i: number): number {
    for (let j = i; j < this.lines.length; j++) if (this.lines[j]!.text.trim()) return j;
    return -1;
  }

  /** A block node starting at line `i` with indent `indent`. */
  parseBlock(i: number, indent: number): unknown {
    const line = this.lines[i]!;
    if (isSeqItem(line.text)) return this.parseSequence(i, indent);
    if (KEY_RE.test(line.text)) return this.parseMapping(i, indent);
    // A bare scalar (possibly folded over more lines).
    let text = line.text;
    let j = i + 1;
    for (let k = this.nextIndex(j); k >= 0 && this.lines[k]!.indent >= indent; k = this.nextIndex(j)) {
      text += ` ${this.lines[k]!.text.trim()}`;
      j = k + 1;
    }
    this.pos = j;
    return parseInline(text.trim(), () => "");
  }

  private parseSequence(i: number, indent: number): unknown[] {
    const out: unknown[] = [];
    let j = i;
    while (j >= 0 && j < this.lines.length) {
      const line = this.lines[j]!;
      if (line.indent !== indent || !isSeqItem(line.text)) break;
      const rest = line.text.replace(/^-\s*/, "");
      const offset = line.text.length - rest.length;
      if (!rest) {
        const next = this.nextIndex(j + 1);
        if (next >= 0 && this.lines[next]!.indent > indent) {
          out.push(this.parseBlock(next, this.lines[next]!.indent));
        } else {
          out.push(null);
          this.pos = j + 1;
        }
      } else if (isSeqItem(rest) || KEY_RE.test(rest)) {
        // `- key: value` / `- - x`: the item is a block starting at the text's column.
        this.lines[j] = { indent: indent + offset, text: rest, raw: line.raw };
        out.push(this.parseBlock(j, indent + offset));
      } else {
        out.push(this.parseValue(rest, j, indent));
      }
      j = this.nextIndex(this.pos);
    }
    this.pos = j < 0 ? this.lines.length : j;
    return out;
  }

  private parseMapping(i: number, indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let j = i;
    while (j >= 0 && j < this.lines.length) {
      const line = this.lines[j]!;
      if (line.indent !== indent) {
        if (line.indent > indent) throw new YamlError(`Bad indentation on line ${j + 1}`);
        break;
      }
      const match = KEY_RE.exec(line.text);
      if (!match) {
        if (isSeqItem(line.text)) break;
        throw new YamlError(`Expected "key: value" on line ${j + 1}`);
      }
      const key = unquoteKey(match[1]!);
      const rest = line.text.slice(match[0].length).trim();
      if (!rest) {
        const next = this.nextIndex(j + 1);
        const child = next >= 0 ? this.lines[next]! : null;
        if (child && (child.indent > indent || (child.indent === indent && isSeqItem(child.text)))) {
          out[key] = this.parseBlock(next, child.indent);
        } else {
          out[key] = null;
          this.pos = j + 1;
        }
      } else {
        out[key] = this.parseValue(rest, j, indent);
      }
      j = this.nextIndex(this.pos);
    }
    this.pos = j < 0 ? this.lines.length : j;
    return out;
  }

  /** The inline value `rest` on line `j` (block scalar, flow collection, scalar with continuation lines). */
  private parseValue(rest: string, j: number, indent: number): unknown {
    if (/^[|>]/.test(rest)) return this.parseBlockScalar(rest, j, indent);
    let text = rest;
    let k = j + 1;
    if (/^[[{]/.test(text)) {
      while (!flowClosed(text) && k < this.lines.length) text += ` ${this.lines[k++]!.text.trim()}`;
    } else if (!/^["']/.test(text)) {
      // Plain scalar continued on more-indented lines.
      for (let n = this.nextIndex(k); n >= 0 && this.lines[n]!.indent > indent && !isSeqItem(this.lines[n]!.text); n = this.nextIndex(k)) {
        // Like YAML: `key: value` can't continue a plain scalar (a mis-indented key).
        if (KEY_RE.test(this.lines[n]!.text)) throw new YamlError(`Bad indentation on line ${n + 1}`);
        text += ` ${this.lines[n]!.text.trim()}`;
        k = n + 1;
      }
    } else if (!quotedClosed(text)) {
      // A quoted string over several lines: lines folded with spaces.
      while (!quotedClosed(text) && k < this.lines.length) text += ` ${this.lines[k++]!.raw.trim()}`;
    }
    this.pos = k;
    return parseInline(text, (msg) => `${msg} on line ${j + 1}`);
  }

  private parseBlockScalar(header: string, j: number, indent: number): string {
    const m = /^([|>])([+-]?)(\d?)([+-]?)\s*$/.exec(header);
    if (!m) throw new YamlError(`Bad block scalar header on line ${j + 1}`);
    const folded = m[1] === ">";
    const chomp = m[2] || m[4] || "";
    const explicit = m[3] ? Number(m[3]) : 0;
    const body: string[] = [];
    let k = j + 1;
    let contentIndent = explicit ? indent + explicit : -1;
    for (; k < this.lines.length; k++) {
      const raw = this.lines[k]!.raw;
      if (!raw.trim()) {
        body.push("");
        continue;
      }
      const lineIndent = raw.length - raw.replace(/^ +/, "").length;
      if (contentIndent < 0) contentIndent = lineIndent;
      if (lineIndent < contentIndent || lineIndent <= indent) break;
      body.push(raw.slice(contentIndent));
    }
    // Trailing blank lines belong to the scalar only for chomping; the parser resumes after content.
    let end = body.length;
    while (end > 0 && body[end - 1] === "") end--;
    this.pos = k - (body.length - end);
    const content = body.slice(0, end);
    const trailing = body.length - end;
    let text = folded ? foldLines(content) : content.join("\n");
    if (!content.length) return "";
    if (chomp === "-") return text;
    text += "\n";
    if (chomp === "+") text += "\n".repeat(trailing);
    return text;
  }
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** `>` folding: lines join with spaces, blank lines become newlines, more-indented lines stay. */
function foldLines(lines: string[]): string {
  let out = "";
  let prevKept = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const literal = line === "" || /^\s/.test(line);
    if (i === 0) out = line;
    else if (line === "") out += "\n";
    else if (literal || prevKept) out += (out.endsWith("\n") ? "" : "\n") + line;
    else out += (out.endsWith("\n") ? "" : " ") + line;
    prevKept = literal;
  }
  return out;
}

function unquoteKey(key: string): string {
  if (key.startsWith('"')) return JSON.parse(key) as string;
  if (key.startsWith("'")) return key.slice(1, -1).replace(/''/g, "'");
  return key.trim();
}

function quotedClosed(text: string): boolean {
  try {
    new FlowParser(text).parseQuoted();
    return true;
  } catch {
    return false;
  }
}

function flowClosed(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth <= 0;
}

/** One inline value: a flow collection, a quoted string or a plain scalar. */
function parseInline(text: string, where: (msg: string) => string): unknown {
  const parser = new FlowParser(text);
  try {
    const value = parser.parseValue(false);
    parser.skipSpace();
    if (!parser.done()) throw new YamlError("Unexpected text after value");
    return value;
  } catch (err) {
    throw new YamlError(where((err as Error).message));
  }
}

class FlowParser {
  i = 0;
  constructor(private readonly s: string) {}

  done(): boolean {
    return this.i >= this.s.length;
  }

  skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  parseValue(inFlow: boolean): unknown {
    this.skipSpace();
    const ch = this.s[this.i];
    if (ch === "[") return this.parseSeq();
    if (ch === "{") return this.parseMap();
    if (ch === '"' || ch === "'") return this.parseQuoted();
    return plainScalar(this.parsePlain(inFlow));
  }

  parseQuoted(): string {
    const q = this.s[this.i];
    if (q !== '"' && q !== "'") throw new YamlError("Expected a quoted string");
    let out = "";
    this.i++;
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (q === "'") {
        if (ch === "'") {
          if (this.s[this.i + 1] === "'") {
            out += "'";
            this.i += 2;
            continue;
          }
          this.i++;
          return out;
        }
      } else if (ch === "\\") {
        const next = this.s[this.i + 1] ?? "";
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0", " ": " ", e: "\x1b", b: "\b" };
        if (next in simple) {
          out += simple[next];
          this.i += 2;
          continue;
        }
        const hex = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
        if (hex) {
          const code = this.s.slice(this.i + 2, this.i + 2 + hex);
          if (!/^[0-9a-fA-F]+$/.test(code) || code.length !== hex) throw new YamlError("Bad escape");
          out += String.fromCodePoint(parseInt(code, 16));
          this.i += 2 + hex;
          continue;
        }
        throw new YamlError(`Unknown escape \\${next}`);
      } else if (ch === '"') {
        this.i++;
        return out;
      }
      out += ch;
      this.i++;
    }
    throw new YamlError("Unterminated string");
  }

  private parsePlain(inFlow: boolean): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (inFlow && (ch === "," || ch === "]" || ch === "}")) break;
      if (inFlow && ch === ":" && (this.i + 1 >= this.s.length || /[\s,\]}]/.test(this.s[this.i + 1]!))) break;
      this.i++;
    }
    return this.s.slice(start, this.i).trim();
  }

  private parseSeq(): unknown[] {
    this.i++; // [
    const out: unknown[] = [];
    for (;;) {
      this.skipSpace();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      if (this.done()) throw new YamlError("Unterminated [list]");
      out.push(this.parseValue(true));
      this.skipSpace();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") throw new YamlError("Expected , or ] in a list");
    }
  }

  private parseMap(): Record<string, unknown> {
    this.i++; // {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipSpace();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      if (this.done()) throw new YamlError("Unterminated {map}");
      const key = this.parseValue(true);
      this.skipSpace();
      let value: unknown = null;
      if (this.s[this.i] === ":") {
        this.i++;
        value = this.parseValue(true);
      }
      out[String(key)] = value;
      this.skipSpace();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") throw new YamlError("Expected , or } in a map");
    }
  }
}

function plainScalar(text: string): unknown {
  if (text === "" || text === "~" || /^(null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(text)) return Number(text);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  return text;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------
// Raw top-level entries and writing
// ---------------------------------------------------------------------------------------------

/** Each top-level key with its raw text (the key line plus its indented/continued lines). */
export function splitTopLevel(source: string): Array<{ key: string; raw: string }> {
  const out: Array<{ key: string; raw: string[] }> = [];
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^\S/.test(raw) && !raw.startsWith("#") && !raw.startsWith("- ") ? KEY_RE.exec(stripComment(raw)) : null;
    if (match) out.push({ key: unquoteKey(match[1]!), raw: [raw] });
    else if (out.length) out[out.length - 1]!.raw.push(raw);
  }
  return out.map((e) => {
    while (e.raw.length > 1 && !e.raw[e.raw.length - 1]!.trim()) e.raw.pop();
    return { key: e.key, raw: e.raw.join("\n") };
  });
}

/** A string as a YAML scalar: plain when that reads back the same, else double-quoted. */
export function yamlString(value: string, inFlow = false): string {
  const plainOk =
    value !== "" &&
    value === value.trim() &&
    !/[\n\t\r]/.test(value) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/: |:$| #/.test(value) &&
    !(inFlow && /[,[\]{}]/.test(value)) &&
    typeof plainScalar(value) === "string";
  return plainOk ? value : JSON.stringify(value);
}

/** A flow list `[a, b]`. */
export function yamlFlowList(values: string[]): string {
  return `[${values.map((v) => yamlString(v, true)).join(", ")}]`;
}
