import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/preact";
import { Markdown, fenced } from "./Markdown";

// jsdom has no layout APIs; Streamdown scrolls code blocks while streaming.
Element.prototype.scrollTo ??= function () {};

describe("Markdown", () => {
  it("renders headings, lists and links (links open in a new tab)", async () => {
    const { container } = render(<Markdown text={"# Title\n\n- one\n- two\n\nSee [docs](https://example.com)."} />);
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Title"));
    expect(container.querySelectorAll("li")).toHaveLength(2);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toMatch(/^https:\/\/example\.com\/?$/);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders a partial code fence while streaming without crashing", async () => {
    const { container, rerender } = render(<Markdown streaming text={"Here:\n\n```ts\nconst a = 1;\nconst b"} />);
    await waitFor(() => expect(container.textContent).toContain("const a = 1;"));
    rerender(<Markdown streaming text={"Here:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone **bo"} />);
    await waitFor(() => expect(container.textContent).toContain("const b = 2;"));
    expect(container.textContent).toContain("Done");
    expect(container.textContent).not.toContain("**");
  });

  it("renders a copy button on code blocks", async () => {
    const { container } = render(<Markdown text={"```js\nlet x = 1\n```"} />);
    await waitFor(() => expect(container.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull());
  });
});

describe("Markdown highlight (I-193: the word being read aloud)", () => {
  const md = "# Plan\n\nRun **the tests** with `pnpm test`, then [read the docs](https://example.com).\n\nLast line here.";
  const marks = (c: Element) => [...c.querySelectorAll("mark[data-reading]")].map((m) => m.textContent);
  const at = (word: string, from = 0): [number, number] => [md.indexOf(word, from), md.indexOf(word, from) + word.length];

  it("wraps the range in a mark, inside emphasis and links, and moves with it", async () => {
    const { container, rerender } = render(<Markdown text={md} highlight={at("tests")} />);
    await waitFor(() => expect(marks(container)).toEqual(["tests"]));
    expect(container.querySelector("[data-streamdown=strong] mark")).not.toBeNull();
    rerender(<Markdown text={md} highlight={at("docs")} />);
    await waitFor(() => expect(marks(container)).toEqual(["docs"]));
    expect(container.querySelector("a mark")).not.toBeNull();
    rerender(<Markdown text={md} highlight={at("line")} />);
    await waitFor(() => expect(marks(container)).toEqual(["line"]));
    expect(container.textContent).toContain("Run the tests with");
    rerender(<Markdown text={md} highlight={at("Plan")} />);
    await waitFor(() => expect(marks(container)).toEqual(["Plan"]));
    rerender(<Markdown text={md} highlight={null} />);
    await waitFor(() => expect(marks(container)).toEqual([]));
  });

  it("marks inline code as a whole", async () => {
    const { container } = render(<Markdown text={md} highlight={at("pnpm")} />);
    await waitFor(() => expect(marks(container)).toEqual(["pnpm test"]));
  });
});

describe("fenced", () => {
  it("uses a fence longer than any backtick run in the source", () => {
    expect(fenced("a ``` b", "md")).toBe("````md\na ``` b\n````");
    expect(fenced("plain\n")).toBe("```\nplain\n```");
  });
});
