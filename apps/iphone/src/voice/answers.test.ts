import { describe, expect, it } from "vitest";
import type { PermissionOption } from "@glade/protocol";
import { matchPermissionAnswer, permissionQuestion, permissionRetryQuestion, rejectOption, type PermissionRequest } from "./answers";

const claude: PermissionOption[] = [
  { id: "allow", label: "Yes", kind: "allow_once" },
  { id: "always", label: "Yes, and don't ask again for npm test commands in /repo", kind: "allow_always" },
  { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
];
const codexExec: PermissionOption[] = [
  { id: "turn", label: "Yes, for this turn", kind: "allow_once" },
  { id: "session", label: "Yes, for this session", kind: "allow_always" },
  { id: "reject", label: "No, and tell Codex what to do differently", kind: "reject_once", focusComposer: true },
];
const codexProceed: PermissionOption[] = [
  { id: "approve", label: "Yes, proceed", kind: "allow_once" },
  { id: "reject", label: "No, and tell Codex what to do differently", kind: "reject_once", focusComposer: true },
];
const acp: PermissionOption[] = [
  { id: "r1", label: "Reject", kind: "reject_once" },
  { id: "r2", label: "Always reject", kind: "reject_always" },
  { id: "a1", label: "Allow", kind: "allow_once" },
  { id: "a2", label: "Always allow", kind: "allow_always" },
];

const id = (said: string, options: PermissionOption[]) => matchPermissionAnswer(said, options)?.id ?? null;

describe("matchPermissionAnswer", () => {
  it("yes / yes always / no on Claude's options", () => {
    for (const said of ["Yes", "yeah", "Yep, go ahead.", "sure", "OK", "allow it", "do it"]) expect(id(said, claude)).toBe("allow");
    for (const said of ["Yes, always", "always", "yes and don't ask again", "Don't ask me again.", "yes, remember that"]) expect(id(said, claude)).toBe("always");
    for (const said of ["No", "nope", "no, don't", "Don't do that", "stop", "cancel"]) expect(id(said, claude)).toBe("reject");
  });

  it("Codex's labels", () => {
    expect(id("yes", codexExec)).toBe("turn");
    expect(id("yes for this session", codexExec)).toBe("session");
    expect(id("always", codexExec)).toBe("session");
    expect(id("Yes, proceed", codexProceed)).toBe("approve");
    expect(id("yes always", codexProceed)).toBeNull();
    expect(id("no", codexProceed)).toBe("reject");
  });

  it("ACP options (rejections listed first)", () => {
    expect(id("yes", acp)).toBe("a1");
    expect(id("always allow", acp)).toBe("a2");
    expect(id("no", acp)).toBe("r1");
  });

  it("by position", () => {
    expect(id("option two", claude)).toBe("always");
    expect(id("the first one", claude)).toBe("allow");
    expect(id("3", claude)).toBe("reject");
    expect(id("number 9", claude)).toBeNull();
  });

  it("unclear answers match nothing", () => {
    for (const said of ["what?", "hmm let me think", "", "the weather is nice"]) expect(id(said, claude)).toBeNull();
  });

  it("'no' picks the rejection that hands back to the user", () => {
    expect(rejectOption(claude)?.id).toBe("reject");
    expect(rejectOption(acp)?.id).toBe("r1");
  });
});

describe("permissionQuestion", () => {
  const request = (title: string, message?: string): PermissionRequest => ({ id: "q", kind: "permission", title, message, options: claude });

  it("<agent> wants to <summary>. Allow?", () => {
    expect(permissionQuestion(request("Allow Bash?", "npm test\nmore"), "Claude Code")).toBe("Claude Code wants to use Bash: npm test. Allow?");
    expect(permissionQuestion(request("Claude wants to read `src/app.ts`"), "Claude Code")).toBe("Claude wants to read src/app.ts. Allow?");
    expect(permissionQuestion(request("Run a command?"), null)).toBe("The agent wants to know: Run a command. Allow?");
  });

  it("asks again with the choices", () => {
    expect(permissionRetryQuestion(claude)).toBe("Sorry, I didn't catch that. Say yes, yes always, or no.");
    expect(permissionRetryQuestion(codexProceed)).toBe("Sorry, I didn't catch that. Say yes or no.");
  });
});
