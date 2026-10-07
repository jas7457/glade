/** I-133: `/settings` reopens the last settings section (and a host section's environment). */
import { beforeEach, describe, expect, it } from "vitest";
import { readStored } from "@glade/app-core/state/ui";
import { lastSettings, rememberSettings, resolveLastSettings } from "./lastSettings";
import { routes } from "@glade/app-core/app/routes";

beforeEach(() => localStorage.clear());

describe("resolveLastSettings", () => {
  const connected = (id: string) => id === "mini";
  it("falls back to General when nothing (or garbage) is stored", () => {
    expect(resolveLastSettings(null)).toEqual({ section: "general", envId: null });
    expect(resolveLastSettings("{nope")).toEqual({ section: "general", envId: null });
    expect(resolveLastSettings("42")).toEqual({ section: "general", envId: null });
  });
  it("falls back to General when the section no longer exists", () => {
    expect(resolveLastSettings(JSON.stringify({ section: "agent-gone", envId: "mini" }), connected)).toEqual({ section: "general", envId: null });
  });
  it("falls back to General for the removed About and Appearance pages (I-160, I-161)", () => {
    expect(resolveLastSettings(JSON.stringify({ section: "about", envId: null }))).toEqual({ section: "general", envId: null });
    expect(resolveLastSettings(JSON.stringify({ section: "appearance", envId: null }))).toEqual({ section: "general", envId: null });
  });
  it("keeps the section, and its environment only while connected", () => {
    expect(resolveLastSettings(JSON.stringify({ section: "prompts", envId: "mini" }), connected)).toEqual({ section: "prompts", envId: "mini" });
    expect(resolveLastSettings(JSON.stringify({ section: "prompts", envId: "gone" }), connected)).toEqual({ section: "prompts", envId: null });
    expect(resolveLastSettings(JSON.stringify({ section: "remote", envId: null }), connected)).toEqual({ section: "remote", envId: null });
  });
});

describe("rememberSettings", () => {
  it("round-trips through localStorage", () => {
    rememberSettings("prompts", "mini");
    expect(readStored("glade.lastSettings")).toBe(JSON.stringify({ section: "prompts", envId: "mini" }));
    expect(lastSettings((id) => id === "mini")).toEqual({ section: "prompts", envId: "mini" });
  });
  it("remembers an agent's page under Agents (I-198)", () => {
    rememberSettings("agent", null, "claude");
    expect(lastSettings()).toEqual({ section: "agent", envId: null, agent: "claude" });
    expect(resolveLastSettings(JSON.stringify({ section: "prompts", envId: null, agent: "claude" }))).toEqual({ section: "prompts", envId: null });
  });
  it("the folded Models page reopens Agents (I-198)", () => {
    expect(resolveLastSettings(JSON.stringify({ section: "models", envId: "mini" }), (id) => id === "mini")).toEqual({ section: "agent", envId: "mini" });
  });
});

describe("routes.settings", () => {
  it("without a section is plain /settings (reopens the last one); with one, a deep link", () => {
    expect(routes.settings()).toBe("/settings");
    expect(routes.settings("prompts")).toBe("/settings/prompts");
    expect(routes.settingsAgent("claude")).toBe("/settings/agent/claude");
  });
});
