import { describe, expect, it } from "vitest";
import { attachmentName, formatAttachedFiles, parseAttachedFiles } from "./attachments.js";

describe("formatAttachedFiles / parseAttachedFiles (I-090)", () => {
  it("appends one line per file after a blank line", () => {
    expect(formatAttachedFiles("Summarise this", ["/d/a/report.pdf", "/d/a/data 1.csv"])).toBe(
      "Summarise this\n\nAttached file: /d/a/report.pdf\nAttached file: /d/a/data 1.csv",
    );
  });
  it("only lines when there's no text; unchanged without files", () => {
    expect(formatAttachedFiles("  ", ["/x.txt"])).toBe("Attached file: /x.txt");
    expect(formatAttachedFiles("hi", [])).toBe("hi");
  });
  it("round-trips", () => {
    const text = "Look at\nthese";
    const files = ["/a/b c.pdf", "/a/d.zip"];
    expect(parseAttachedFiles(formatAttachedFiles(text, files))).toEqual({ text, files });
    expect(parseAttachedFiles(formatAttachedFiles("", files))).toEqual({ text: "", files });
  });
  it("only takes a trailing block of absolute paths", () => {
    const text = "Attached file: /early.txt\nmiddle\nAttached file: relative.txt";
    expect(parseAttachedFiles(text)).toEqual({ text, files: [] });
    expect(parseAttachedFiles("hi\nAttached file: /x\n")).toEqual({ text: "hi", files: ["/x"] });
  });
  it("names", () => {
    expect(attachmentName("/a/b/report.pdf")).toBe("report.pdf");
    expect(attachmentName("x")).toBe("x");
  });
});
