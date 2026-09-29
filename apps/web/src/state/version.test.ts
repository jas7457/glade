/** I-149: the About page's text and another device's build vs. ours (pure). */
import { describe, expect, it } from "vitest";
import type { BuildInfo, VersionStatus } from "@glade/protocol";
import { buildLine, buildRelation, buildRelationText, checkText } from "./version";

const OURS: BuildInfo = { commit: "a".repeat(40), shortCommit: "aaaaaaa", builtAt: "2026-09-27T10:00:00.000Z", dirty: false, repoPath: "/src/glade", kind: "release" };
const OLDER: BuildInfo = { ...OURS, commit: "b".repeat(40), shortCommit: "bbbbbbb", builtAt: "2026-09-20T10:00:00.000Z" };
const NEWER: BuildInfo = { ...OURS, commit: "c".repeat(40), shortCommit: "ccccccc", builtAt: "2026-09-28T10:00:00.000Z" };
const at = "2026-09-27T12:00:00.000Z";

describe("version text", () => {
  it("describes the build", () => {
    expect(buildLine(OURS, "en-US")).toBe("Built from aaaaaaa on Sep 27, 2026");
    expect(buildLine({ ...OURS, kind: "dev" }, "en-US")).toBe("Running from source at aaaaaaa (committed Sep 27, 2026)");
  });

  it("describes each check state", () => {
    const status = (check: VersionStatus["check"]): VersionStatus => ({ build: OURS, check, checking: false });
    expect(checkText(status({ state: "up-to-date", checkedAt: at })).text).toBe("Up to date");
    expect(checkText(status({ state: "behind", behind: 1, checkedAt: at })).text).toBe("1 commit behind main");
    expect(checkText(status({ state: "behind", behind: 12, checkedAt: at })).text).toBe("12 commits behind main");
    expect(checkText(status({ state: "update-available", checkedAt: at })).text).toBe("Update available");
    expect(checkText(status({ state: "failed", reason: "offline", checkedAt: at }))).toMatchObject({ text: "Couldn't check", detail: "offline", tone: "error" });
    expect(checkText(status(null)).text).toBe("Not checked yet");
    expect(checkText({ build: null, check: null, checking: false }).text).toBe("Unknown build");
  });
});

describe("buildRelation", () => {
  it("uses the commit count when our repo could count it", () => {
    expect(buildRelation(OURS, OLDER, { commit: OLDER.commit, relation: "older", count: 3 })).toEqual({ relation: "older", count: 3 });
    expect(buildRelation(OURS, NEWER, { commit: NEWER.commit, relation: "newer", count: 1 })).toEqual({ relation: "newer", count: 1 });
  });

  it("falls back to build times when it couldn't", () => {
    expect(buildRelation(OURS, OLDER, { commit: OLDER.commit, relation: "unknown" })).toEqual({ relation: "older" });
    expect(buildRelation(OURS, NEWER)).toEqual({ relation: "newer" });
  });

  it("says nothing for the same build or unknown builds", () => {
    expect(buildRelation(OURS, { ...OURS })).toBeNull();
    expect(buildRelation(OURS, null)).toBeNull();
    expect(buildRelation(undefined, OLDER)).toBeNull();
    expect(buildRelation(OURS, OLDER, { commit: OLDER.commit, relation: "same" })).toBeNull();
  });

  it("reads well", () => {
    expect(buildRelationText({ relation: "older", count: 3 })).toBe("Running an older Glade (3 commits behind this device)");
    expect(buildRelationText({ relation: "newer", count: 1 })).toBe("Running a newer Glade (1 commit ahead of this device)");
    expect(buildRelationText({ relation: "older" })).toBe("Running an older Glade");
  });
});
