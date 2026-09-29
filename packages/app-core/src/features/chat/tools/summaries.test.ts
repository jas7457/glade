import { describe, expect, it } from "vitest";
import { splitLeadingCd } from "./summaries";

describe("splitLeadingCd (I-152)", () => {
  const cwd = "/Users/me/src/glade";
  const home = "/Users/me";
  it("drops a cd into the chat's own folder", () => {
    expect(splitLeadingCd(`cd ${cwd} && grep -n x a.ts`, cwd, home)).toEqual({ dir: null, rest: "grep -n x a.ts" });
    expect(splitLeadingCd(`cd ${cwd}/ ; ls`, cwd, home)).toEqual({ dir: null, rest: "ls" });
    expect(splitLeadingCd(`cd "${cwd}" && ls`, cwd, home)).toEqual({ dir: null, rest: "ls" });
    expect(splitLeadingCd(`cd . && ls`, cwd, home)).toEqual({ dir: null, rest: "ls" });
  });
  it("labels subfolders relative to the chat's folder", () => {
    expect(splitLeadingCd(`cd ${cwd}/apps/web/src && ls`, cwd, home)).toEqual({ dir: "apps/web/src", rest: "ls" });
    expect(splitLeadingCd(`cd apps/web && npx vitest`, cwd, home)).toEqual({ dir: "apps/web", rest: "npx vitest" });
    expect(splitLeadingCd(`pushd ./apps && ls`, cwd, home)).toEqual({ dir: "apps", rest: "ls" });
  });
  it("shortens other folders with ~", () => {
    expect(splitLeadingCd(`cd the extension kit && git status`, cwd, home)).toEqual({ dir: "the extension kit", rest: "git status" });
    expect(splitLeadingCd(`cd /tmp/x && ls`, cwd, home)).toEqual({ dir: "/tmp/x", rest: "ls" });
  });
  it("leaves commands without a leading cd (or only a cd) alone", () => {
    expect(splitLeadingCd("ls -la", cwd, home)).toBeNull();
    expect(splitLeadingCd(`cd ${cwd}`, cwd, home)).toBeNull();
    expect(splitLeadingCd(`echo cd x && ls`, cwd, home)).toBeNull();
  });
});
