/**
 * A small TOML reader for Codex agent files (`~/.codex/agents/*.toml`, I-218). No TOML package is a
 * dependency; this covers TOML 1.0 minus dates/times (read as strings): bare/quoted/dotted keys,
 * basic and literal strings (also `"""`/`'''` multi-line), integers (`_`, hex/oct/bin), floats,
 * booleans, arrays (multi-line, nested), inline tables, `[table]` and `[[array of tables]]`
 * headers, comments. Throws {@link TomlError} with a line number on bad input.
 */

export class TomlError extends Error {}

type Table = Record<string, unknown>;

export function parseToml(source: string): Table {
  return new TomlParser(source.replace(/\r\n?/g, "\n")).parse();
}

class TomlParser {
  private i = 0;
  private readonly root: Table = {};
  /** Tables created by a `[header]` (redefining one is an error) and by dotted keys. */
  private readonly defined = new Set<Table>();

  constructor(private readonly s: string) {}

  parse(): Table {
    let current = this.root;
    for (;;) {
      this.skipWsCommentsNewlines();
      if (this.i >= this.s.length) return this.root;
      if (this.s[this.i] === "[") {
        current = this.parseHeader();
      } else {
        this.parseKeyValue(current);
      }
      this.expectLineEnd();
    }
  }

  private line(): number {
    return this.s.slice(0, this.i).split("\n").length;
  }

  private fail(msg: string): never {
    throw new TomlError(`${msg} on line ${this.line()}`);
  }

  private skipWs(): void {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }

  private skipComment(): void {
    if (this.s[this.i] === "#") while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
  }

  private skipWsCommentsNewlines(): void {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (this.s[this.i] === "\n") this.i++;
      else return;
    }
  }

  private expectLineEnd(): void {
    this.skipWs();
    this.skipComment();
    if (this.i < this.s.length && this.s[this.i] !== "\n") this.fail("Expected the end of the line");
  }

  private parseHeader(): Table {
    const array = this.s.startsWith("[[", this.i);
    this.i += array ? 2 : 1;
    this.skipWs();
    const keys = this.parseKey();
    this.skipWs();
    if (!this.s.startsWith(array ? "]]" : "]", this.i)) this.fail("Unclosed table header");
    this.i += array ? 2 : 1;
    let table = this.root;
    for (const key of keys.slice(0, -1)) table = this.descend(table, key);
    const last = keys[keys.length - 1]!;
    if (array) {
      const list = (table[last] ??= []) as unknown;
      if (!Array.isArray(list)) this.fail(`"${last}" is not an array of tables`);
      const next: Table = {};
      (list as Table[]).push(next);
      return next;
    }
    const existing = table[last];
    if (existing !== undefined) {
      if (!isTable(existing) || this.defined.has(existing)) this.fail(`Table "${keys.join(".")}" defined twice`);
      this.defined.add(existing as Table);
      return existing as Table;
    }
    const next: Table = {};
    this.defined.add(next);
    table[last] = next;
    return next;
  }

  /** The child table `key` of `table` (the last element of an array of tables), created if missing. */
  private descend(table: Table, key: string): Table {
    const value = table[key];
    if (value === undefined) return (table[key] = {}) as Table;
    if (Array.isArray(value) && isTable(value[value.length - 1])) return value[value.length - 1] as Table;
    if (!isTable(value)) this.fail(`"${key}" is not a table`);
    return value as Table;
  }

  private parseKeyValue(table: Table): void {
    const keys = this.parseKey();
    this.skipWs();
    if (this.s[this.i] !== "=") this.fail("Expected =");
    this.i++;
    this.skipWs();
    const value = this.parseValue();
    let target = table;
    for (const key of keys.slice(0, -1)) target = this.descend(target, key);
    const last = keys[keys.length - 1]!;
    if (last in target) this.fail(`Key "${keys.join(".")}" defined twice`);
    target[last] = value;
  }

  private parseKey(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipWs();
      const ch = this.s[this.i];
      if (ch === '"') keys.push(this.parseBasicString());
      else if (ch === "'") keys.push(this.parseLiteralString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
        if (!m) this.fail("Expected a key");
        keys.push(m[0]);
        this.i += m[0].length;
      }
      this.skipWs();
      if (this.s[this.i] !== ".") return keys;
      this.i++;
    }
  }

  private parseValue(): unknown {
    const ch = this.s[this.i];
    if (this.s.startsWith('"""', this.i)) return this.parseMultilineBasic();
    if (this.s.startsWith("'''", this.i)) return this.parseMultilineLiteral();
    if (ch === '"') return this.parseBasicString();
    if (ch === "'") return this.parseLiteralString();
    if (ch === "[") return this.parseArray();
    if (ch === "{") return this.parseInlineTable();
    const m = /^[^\s,\]}#]+(?: [0-9:.+\-Z]+)?/.exec(this.s.slice(this.i));
    if (!m) this.fail("Expected a value");
    this.i += m[0].length;
    return scalar(m[0]) ?? this.fail(`Bad value "${m[0]}"`);
  }

  private parseBasicString(): string {
    this.i++; // "
    let out = "";
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === '"') {
        this.i++;
        return out;
      }
      if (ch === "\n") this.fail("Unterminated string");
      if (ch === "\\") out += this.parseEscape();
      else {
        out += ch;
        this.i++;
      }
    }
    return this.fail("Unterminated string");
  }

  private parseEscape(): string {
    const next = this.s[this.i + 1] ?? "";
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
    if (next in simple) {
      this.i += 2;
      return simple[next]!;
    }
    const len = next === "u" ? 4 : next === "U" ? 8 : next === "x" ? 2 : 0;
    const hex = this.s.slice(this.i + 2, this.i + 2 + len);
    if (!len || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) this.fail(`Bad escape \\${next}`);
    this.i += 2 + len;
    return String.fromCodePoint(parseInt(hex, 16));
  }

  private parseLiteralString(): string {
    const end = this.s.indexOf("'", this.i + 1);
    const nl = this.s.indexOf("\n", this.i + 1);
    if (end < 0 || (nl >= 0 && nl < end)) this.fail("Unterminated string");
    const out = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return out;
  }

  private parseMultilineBasic(): string {
    this.i += 3;
    if (this.s[this.i] === "\n") this.i++;
    let out = "";
    while (this.i < this.s.length) {
      if (this.s.startsWith('"""', this.i)) {
        // Up to two quotes right before the closing ones belong to the string.
        let extra = 0;
        while (extra < 2 && this.s[this.i + 3 + extra] === '"') extra++;
        out += '"'.repeat(extra);
        this.i += 3 + extra;
        return out;
      }
      const ch = this.s[this.i]!;
      if (ch === "\\") {
        // Line-ending backslash: trim the newline and following whitespace.
        const rest = /^\\[ \t]*\n[\s]*/.exec(this.s.slice(this.i));
        if (rest) {
          this.i += rest[0].length;
          continue;
        }
        out += this.parseEscape();
      } else {
        out += ch;
        this.i++;
      }
    }
    return this.fail("Unterminated multi-line string");
  }

  private parseMultilineLiteral(): string {
    this.i += 3;
    if (this.s[this.i] === "\n") this.i++;
    const end = this.s.indexOf("'''", this.i);
    if (end < 0) this.fail("Unterminated multi-line string");
    let close = end;
    let extra = 0;
    while (extra < 2 && this.s[close + 3] === "'") {
      close++;
      extra++;
    }
    const out = this.s.slice(this.i, close);
    this.i = close + 3;
    return out;
  }

  private parseArray(): unknown[] {
    this.i++; // [
    const out: unknown[] = [];
    for (;;) {
      this.skipWsCommentsNewlines();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) this.fail("Unterminated array");
      out.push(this.parseValue());
      this.skipWsCommentsNewlines();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") this.fail("Expected , or ] in an array");
    }
  }

  private parseInlineTable(): Table {
    this.i++; // {
    const out: Table = {};
    this.skipWs();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.skipWs();
      this.parseKeyValue(out);
      this.skipWs();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      if (this.s[this.i] !== ",") this.fail("Expected , or } in an inline table");
      this.i++;
    }
  }
}

function scalar(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  const plain = text.replace(/_/g, "");
  if (/^[+-]?(0|[1-9][0-9]*)$/.test(plain)) return Number(plain);
  if (/^0x[0-9a-fA-F]+$/.test(plain)) return parseInt(plain.slice(2), 16);
  if (/^0o[0-7]+$/.test(plain)) return parseInt(plain.slice(2), 8);
  if (/^0b[01]+$/.test(plain)) return parseInt(plain.slice(2), 2);
  if (/^[+-]?(inf|nan)$/.test(plain)) return plain.endsWith("inf") ? (plain.startsWith("-") ? -Infinity : Infinity) : NaN;
  if (/^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(plain)) return Number(plain);
  // Dates and times: kept as written.
  if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(text)) return text;
  return undefined;
}

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
