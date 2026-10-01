import { describe, expect, it } from "vitest";
import type { PermissionOption } from "@glade/protocol";
import {
  isVoiceQuestion,
  matchAnswer,
  matchConfirmAnswer,
  matchPermissionAnswer,
  matchSelectAnswer,
  permissionQuestion,
  permissionRetryQuestion,
  questionText,
  rejectOption,
  retryText,
  type PermissionRequest,
} from "./answers";

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

describe("other questions (I-193)", () => {
  const dbs = ["PostgreSQL", "SQLite", "MySQL (via Docker)"];
  const pick = (said: string, options = dbs) => matchSelectAnswer(said, options);

  it("a select by name, fuzzy", () => {
    expect(pick("PostgreSQL")).toBe(0);
    expect(pick("postgres sql")).toBe(0);
    expect(pick("let's go with SQLite please")).toBe(1);
    expect(pick("sequel light")).toBeNull();
    // How SQL is often said (and recognized).
    expect(pick("sequel lite")).toBe(1);
    expect(pick("my sequel")).toBe(2);
    expect(pick("MySQL")).toBe(2);
    expect(pick("my sql via docker")).toBe(2);
    expect(pick("Postgre SQL")).toBe(0);
    expect(pick("I'll take the one with docker")).toBe(2);
  });

  it("a select by number or position", () => {
    expect(pick("the second one")).toBe(1);
    expect(pick("number 3")).toBe(2);
    expect(pick("1")).toBe(0);
    expect(pick("the last one")).toBe(2);
    expect(pick("option four")).toBeNull();
  });

  it("an unclear or ambiguous select answer matches nothing", () => {
    expect(pick("hmm")).toBeNull();
    expect(pick("the weather")).toBeNull();
    expect(matchSelectAnswer("yes", ["Yes, keep it", "Yes, delete it"])).toBeNull();
    expect(matchSelectAnswer("yes delete it", ["Yes, keep it", "Yes, delete it"])).toBe(1);
  });

  it("a confirm by yes / no", () => {
    expect(matchConfirmAnswer("yeah sure")).toBe(true);
    expect(matchConfirmAnswer("no thanks")).toBe(false);
    expect(matchConfirmAnswer("don't")).toBe(false);
    expect(matchConfirmAnswer("banana")).toBeNull();
  });

  it("the response for each kind", () => {
    expect(matchAnswer({ id: "s", kind: "select", title: "Which?", options: dbs }, "sqlite")).toEqual({ id: "s", value: "SQLite" });
    expect(matchAnswer({ id: "c", kind: "confirm", title: "Delete?" }, "nope")).toEqual({ id: "c", confirmed: false });
    expect(matchAnswer({ id: "i", kind: "input", title: "Name?" }, " Glade app ")).toEqual({ id: "i", value: "Glade app" });
    expect(matchAnswer({ id: "i", kind: "input", title: "Name?" }, "  ")).toBeNull();
    expect(matchAnswer({ id: "p", kind: "permission", title: "Allow?", options: claude }, "yes")).toEqual({ id: "p", value: "allow" });
  });

  it("which questions voice answers", () => {
    expect(isVoiceQuestion({ id: "e", kind: "editor", title: "Edit" })).toBe(false);
    expect(isVoiceQuestion({ id: "s", kind: "select", title: "Pick", options: [] })).toBe(false);
    expect(isVoiceQuestion({ id: "s", kind: "select", title: "Pick", options: ["a"] })).toBe(true);
  });

  it("says the question", () => {
    expect(questionText({ id: "s", kind: "select", title: "Which database?", options: dbs }, null)).toBe("Which database? The options are PostgreSQL, SQLite or MySQL (via Docker).");
    expect(questionText({ id: "s", kind: "select", title: "Pick a **file**", options: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }, null)).toBe(
      "Pick a file. The options are: 1: a.ts. 2: b.ts. 3: c.ts. 4: d.ts. 5: e.ts.",
    );
    expect(questionText({ id: "c", kind: "confirm", title: "Delete the branch?", message: "feature/x is merged" }, null)).toBe("Delete the branch? feature/x is merged. Yes or no?");
    expect(questionText({ id: "i", kind: "input", title: "What should the file be called" }, null)).toBe("What should the file be called.");
    expect(retryText({ id: "s", kind: "select", title: "Which?", options: dbs })).toBe("Sorry, I didn't catch that. Say the name or the number of an option.");
  });
});
