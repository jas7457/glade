import { describe, expect, it } from "vitest";
import { displayPath, homeOf, resolvePath } from "./paths";

describe("paths (I-158)", () => {
  const cwd = "/Users/me/src/glade";
  const home = "/Users/me";
  it("finds the home folder of a chat's folder", () => {
    expect(homeOf(cwd)).toBe(home);
    expect(homeOf("/home/pi/x")).toBe("/home/pi");
    expect(homeOf("/tmp/x")).toBeNull();
    expect(homeOf(null)).toBeNull();
  });
  it("resolves tool paths to absolute ones", () => {
    expect(resolvePath("a/b.ts", cwd, home)).toBe(`${cwd}/a/b.ts`);
    expect(resolvePath("./a/../b.ts", cwd, home)).toBe(`${cwd}/b.ts`);
    expect(resolvePath("@a.ts", cwd, home)).toBe(`${cwd}/a.ts`);
    expect(resolvePath("~/x", cwd, home)).toBe("/Users/me/x");
    expect(resolvePath("$HOME/x", cwd, home)).toBe("/Users/me/x");
    expect(resolvePath("/a//b/", cwd, home)).toBe("/a/b");
    expect(resolvePath("a.ts", null, null)).toBe("a.ts");
    expect(resolvePath("~/x", cwd, null)).toBe("~/x");
  });
  it("shows paths relative to the folder, the folder as ., others ~-shortened", () => {
    expect(displayPath(`${cwd}/packages/protocol/src/api.ts`, cwd, home)).toBe("packages/protocol/src/api.ts");
    expect(displayPath(cwd, cwd, home)).toBe(".");
    expect(displayPath(`${cwd}/`, `${cwd}/`, home)).toBe(".");
    expect(displayPath(".", cwd, home)).toBe(".");
    expect(displayPath("./src/a.ts", cwd, home)).toBe("src/a.ts");
    expect(displayPath("../ext-kit/a.ts", cwd, home)).toBe("~/src/ext-kit/a.ts");
    expect(displayPath(`${cwd}-worktrees/x/a.ts`, cwd, home)).toBe("~/src/glade-worktrees/x/a.ts");
    expect(displayPath("/tmp/x.log", cwd, home)).toBe("/tmp/x.log");
    expect(displayPath("~/notes.md", cwd, home)).toBe("~/notes.md");
  });
  it("only ~-shortens without a folder and leaves unresolvable paths alone", () => {
    expect(displayPath("/Users/me/a.ts", null, home)).toBe("~/a.ts");
    expect(displayPath("src/a.ts", null, null)).toBe("src/a.ts");
    expect(displayPath("/Users/me/a.ts", null, null)).toBe("/Users/me/a.ts");
  });
});
