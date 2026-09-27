import { describe, expect, it } from "vitest";
import { dayDividers, dayLabel, formatMessageDateTime, formatMessageTime } from "./message-time";

// Local-time dates, so the tests don't depend on the machine's time zone.
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const now = at(2026, 9, 27, 15, 0);

describe("formatMessageTime", () => {
  it("follows the locale's clock", () => {
    expect(formatMessageTime(at(2026, 9, 27, 14, 32), "en-GB")).toBe("14:32");
    expect(formatMessageTime(at(2026, 9, 27, 14, 32), "en-US")).toMatch(/^2:32\sPM$/);
  });
});

describe("formatMessageDateTime", () => {
  it("has weekday, date, year and seconds", () => {
    const s = formatMessageDateTime(at(2026, 9, 27, 14, 32, 5), "en-GB");
    for (const part of ["Sun", "27", "Sep", "2026", "14:32:05"]) expect(s).toContain(part);
  });
});

describe("dayLabel", () => {
  it("says Today / Yesterday / weekday + date, with the year only for other years", () => {
    expect(dayLabel(at(2026, 9, 27, 0, 1), now, "en-GB")).toBe("Today");
    expect(dayLabel(at(2026, 9, 26, 23, 59), now, "en-GB")).toBe("Yesterday");
    expect(dayLabel(at(2026, 9, 25), now, "en-GB")).toMatch(/^Fri 25 Sep/);
    expect(dayLabel(at(2025, 12, 31), now, "en-GB")).toMatch(/2025/);
    expect(dayLabel(at(2026, 9, 25), now, "en-GB")).not.toMatch(/2026/);
  });

  it("handles month and year boundaries for Yesterday", () => {
    expect(dayLabel(at(2025, 12, 31, 22), at(2026, 1, 1, 8), "en-GB")).toBe("Yesterday");
  });
});

describe("dayDividers", () => {
  it("marks day changes, and the first message only when it isn't from today", () => {
    const ts = [at(2026, 9, 25, 9), at(2026, 9, 25, 10), at(2026, 9, 26, 9), at(2026, 9, 27, 9), at(2026, 9, 27, 10)];
    const labels = dayDividers(ts, now, "en-GB");
    expect(labels[0]).toMatch(/^Fri 25 Sep/);
    expect(labels.slice(1)).toEqual([null, "Yesterday", "Today", null]);
  });

  it("no divider for a chat from today", () => {
    expect(dayDividers([at(2026, 9, 27, 9), at(2026, 9, 27, 14)], now)).toEqual([null, null]);
  });

  it("skips messages without a time", () => {
    expect(dayDividers([0, at(2026, 9, 27, 9), undefined, at(2026, 9, 27, 10)], now)).toEqual([null, null, null, null]);
  });
});
