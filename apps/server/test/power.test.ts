/** I-147/I-150: awake reasons (fake harness), the settings/AC-battery rules, the long-poll routes. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awakeReasonText, computeAwakeReasons, defaultSettings, type AgentEvent, type PowerSource, type ServerMessage } from "@glade/protocol";
import type { FakeSession } from "../src/harness/fake/fake-harness.js";
import { createApp } from "../src/http/app.js";
import { createPowerTracker, parsePmsetBatt, type PowerTracker } from "../src/services/power.js";
import { createTestEnv, newChat, until, type TestEnv } from "./helpers.js";

const ON = { whileWorking: true, whileShared: true, whileSharedOnBattery: false };

describe("computeAwakeReasons", () => {
  it("working chats keep it awake unless the setting is off", () => {
    const base = { workingChats: 2, sharingOn: false, connectedDevices: [], powerSource: null };
    expect(computeAwakeReasons({ ...base, settings: ON }).reasons).toEqual([{ kind: "working", chats: 2 }]);
    expect(computeAwakeReasons({ ...base, settings: { ...ON, whileWorking: false } }).reasons).toEqual([]);
    expect(computeAwakeReasons({ ...base, workingChats: 0, settings: ON }).reasons).toEqual([]);
  });

  it("sharing needs a connected device; on by default on AC, off on battery unless allowed", () => {
    const shared = { workingChats: 0, sharingOn: true, connectedDevices: ["iPhone"] };
    expect(computeAwakeReasons({ ...shared, connectedDevices: [], powerSource: "ac", settings: ON }).reasons).toEqual([]);
    expect(computeAwakeReasons({ ...shared, sharingOn: false, powerSource: "ac", settings: ON }).reasons).toEqual([]);
    expect(computeAwakeReasons({ ...shared, powerSource: "ac", settings: ON })).toEqual({ reasons: [{ kind: "shared", devices: ["iPhone"] }], sharedSkipped: null });
    // Unknown source (a desktop Mac): like AC.
    expect(computeAwakeReasons({ ...shared, powerSource: null, settings: ON }).reasons).toHaveLength(1);
    expect(computeAwakeReasons({ ...shared, powerSource: "battery", settings: ON })).toEqual({ reasons: [], sharedSkipped: "battery" });
    expect(computeAwakeReasons({ ...shared, powerSource: "battery", settings: { ...ON, whileSharedOnBattery: true } }).reasons).toHaveLength(1);
    expect(computeAwakeReasons({ ...shared, powerSource: "ac", settings: { ...ON, whileShared: false } })).toEqual({ reasons: [], sharedSkipped: "setting" });
  });

  it("defaults: on while working, on while shared (AC), off on battery", () => {
    expect(defaultSettings().power).toEqual({ whileWorking: true, whileShared: true, whileSharedOnBattery: false });
  });

  it("describes the reasons", () => {
    expect(awakeReasonText([{ kind: "working", chats: 1 }])).toBe("a chat is working");
    expect(awakeReasonText([{ kind: "working", chats: 3 }, { kind: "shared", devices: ["iPad", "iPhone"] }])).toBe("3 chats are working · iPad and iPhone are connected");
    expect(awakeReasonText([])).toBe("");
  });

  it("reads pmset", () => {
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 100%")).toBe("ac");
    expect(parsePmsetBatt("Now drawing from 'Battery Power'\n")).toBe("battery");
    expect(parsePmsetBatt("")).toBeNull();
  });
});

describe("PowerTracker (fake harness)", () => {
  let env: TestEnv;
  let tracker: PowerTracker;
  let sharing = false;
  let devices: string[] = [];
  let source: PowerSource | null = "ac";
  let socketListener: () => void = () => {};
  const pushed: ServerMessage[] = [];

  beforeEach(() => {
    env = createTestEnv();
    sharing = false;
    devices = [];
    source = "ac";
    pushed.length = 0;
    tracker = createPowerTracker({
      service: env.service,
      auth: {
        isRemoteEnabled: () => sharing,
        connectedDeviceNames: () => devices,
        onSocketsChange: (l) => {
          socketListener = l;
          return () => {};
        },
        pushLocal: (m) => pushed.push(m),
      },
      canHold: true,
      tickMs: 0,
      powerSource: async () => source,
    });
  });
  afterEach(async () => {
    tracker.dispose();
    await env.cleanup();
  });

  const session = (): FakeSession => [...env.harness.openSessions][0]!;
  const emit = (e: AgentEvent) => session().emit(e);

  it("holds while a chat on this server works, releases after", async () => {
    await newChat(env);
    expect(tracker.power()).toMatchObject({ reasons: [], held: false, canHold: true });
    emit({ type: "run_start" });
    await until(() => tracker.power().held);
    expect(tracker.power().reasons).toEqual([{ kind: "working", chats: 1 }]);
    expect(tracker.current().chats.working).toBe(1);
    expect(pushed.at(-1)).toMatchObject({ type: "power", power: { held: true } });
    emit({ type: "run_end" });
    await until(() => !tracker.power().held);
    expect(tracker.current().chats).toEqual({ working: 0, needsYou: 1 }); // finished unseen = unread
  });

  it("follows the whileWorking setting", async () => {
    await newChat(env);
    env.service.updateSettings({ power: { whileWorking: false } });
    emit({ type: "run_start" });
    await until(() => tracker.current().chats.working === 1);
    expect(tracker.power().reasons).toEqual([]);
    env.service.updateSettings({ power: { whileWorking: true } });
    await until(() => tracker.power().held);
  });

  it("holds while shared with a connected device, on AC only by default", async () => {
    sharing = true;
    devices = ["iPhone"];
    socketListener();
    await until(() => tracker.power().held);
    expect(tracker.current().sharing).toEqual({ on: true, devices: ["iPhone"] });
    source = "battery";
    // The power source is cached; a new tracker reads it fresh.
    const fresh = createPowerTracker({
      service: env.service,
      auth: { isRemoteEnabled: () => true, connectedDeviceNames: () => ["iPhone"], onSocketsChange: () => () => {}, pushLocal: () => {} },
      canHold: true,
      tickMs: 0,
      powerSource: async () => "battery",
    });
    await until(() => fresh.power().powerSource === "battery");
    expect(fresh.power()).toMatchObject({ reasons: [], held: false, sharedSkipped: "battery" });
    env.service.updateSettings({ power: { whileSharedOnBattery: true } });
    await until(() => fresh.power().held);
    fresh.dispose();
  });

  it("web-only servers report reasons but never hold", async () => {
    const devTracker = createPowerTracker({
      service: env.service,
      auth: { isRemoteEnabled: () => false, connectedDeviceNames: () => [], onSocketsChange: () => () => {}, pushLocal: () => {} },
      canHold: false,
      tickMs: 0,
    });
    await newChat(env);
    emit({ type: "run_start" });
    await until(() => devTracker.power().reasons.length === 1);
    expect(devTracker.power()).toMatchObject({ held: false, canHold: false });
    devTracker.dispose();
  });

  it("long-polls: answers at once for a stale rev, else on the next change", async () => {
    await newChat(env);
    const first = await tracker.wait(null);
    const stale = await tracker.wait(first.rev + 5);
    expect(stale.rev).toBe(first.rev);
    const next = tracker.wait(first.rev, 5000);
    emit({ type: "run_start" });
    const changed = await next;
    expect(changed.rev).toBeGreaterThan(first.rev);
    expect(changed.chats.working).toBe(1);
    // Times out with the same state.
    const timedOut = await tracker.wait(changed.rev, 20);
    expect(timedOut.rev).toBe(changed.rev);
  });

  it("serves GET /api/power and /api/desktop/state to the local owner", async () => {
    const { app } = createApp({ service: env.service, power: tracker });
    const power = await app.request("http://127.0.0.1/api/power", { headers: { host: "127.0.0.1" } });
    expect(power.status).toBe(200);
    expect(await power.json()).toMatchObject({ reasons: [], held: false });
    const state = await app.request("http://127.0.0.1/api/desktop/state", { headers: { host: "127.0.0.1" } });
    expect(await state.json()).toMatchObject({ rev: expect.any(Number), chats: { working: 0 }, sharing: { on: false } });
    // Remote requests (proxied) are refused.
    const remote = await app.request("http://127.0.0.1/api/power", { headers: { host: "127.0.0.1", "x-forwarded-for": "100.64.0.2" } });
    expect(remote.status).toBeGreaterThanOrEqual(400);
  });
});
