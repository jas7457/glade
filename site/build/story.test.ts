import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEDIA, type MediaSpec } from "./media.ts";
import { STORY_CAPTIONS, injectStory, parseStory, renderStory, storyCaption } from "./story.ts";

const spec = (name: string): MediaSpec => MEDIA.find((m) => m.name === name)!;
const step = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  label: id.toUpperCase(),
  start,
  end,
  rect: { x: 144, y: 90, w: 720, h: 450 },
  ...extra,
});
const json = (data: unknown) => JSON.stringify(data);

describe("parseStory", () => {
  it("reads a well-formed story, sorted by start time", () => {
    const story = parseStory(json({ width: 1440, height: 900, duration: 20, steps: [step("b", 5, 9), step("a", 0, 5, { caption: " Hi " })] }));
    expect(story?.steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(story?.steps[0]?.caption).toBe("Hi");
    expect(story?.steps[1]?.caption).toBeUndefined();
  });

  it("drops malformed steps and clamps rectangles to the window", () => {
    const story = parseStory(
      json({
        width: 1440,
        height: 900,
        duration: 10,
        steps: [step("ok", 0, 4, { rect: { x: 1400, y: -10, w: 200, h: 100 } }), { id: "no-rect", label: "x", start: 1, end: 2 }, "nope", step("", 2, 3)],
      }),
    );
    expect(story?.steps).toHaveLength(1);
    expect(story?.steps[0]?.rect).toEqual({ x: 1400, y: 0, w: 40, h: 100 });
  });

  it("rejects stories without a size, a duration or any usable step", () => {
    expect(parseStory("not json")).toBeUndefined();
    expect(parseStory(json({ width: 0, height: 900, duration: 5, steps: [step("a", 0, 1)] }))).toBeUndefined();
    expect(parseStory(json({ width: 1440, height: 900, steps: [step("a", 0, 1)] }))).toBeUndefined();
    expect(parseStory(json({ width: 1440, height: 900, duration: 5, steps: [] }))).toBeUndefined();
  });

  it("reads the stand-in sample", () => {
    const sample = parseStory(readFileSync(new URL("../dev/hero-story.sample.json", import.meta.url), "utf8"));
    expect(sample?.steps.map((s) => s.id)).toEqual(["agent", "ask", "sidebar", "work", "done"]);
  });
});

describe("storyCaption", () => {
  it("prefers the recording's caption, then the site's own, then the label", () => {
    expect(storyCaption({ ...step("agent", 0, 1), caption: "Own" })).toBe("Own");
    expect(storyCaption(step("agent", 0, 1))).toBe(STORY_CAPTIONS.agent);
    expect(storyCaption(step("other", 0, 1))).toBe("OTHER");
  });
});

describe("renderStory", () => {
  const story = parseStory(json({ width: 1440, height: 900, duration: 12, steps: [step("agent", 0, 4), step("ask", 4, 12, { caption: 'Say "hi" <b>' })] }))!;
  const still = { file: "hero-story.png", width: 2880, height: 1800, variants: [] };

  it("renders the video (sources loaded later), the spotlight, the caption slot and a seekable step per step", () => {
    const html = renderStory(story, { spec: spec("hero-story"), found: { still, webm: "hero-story.webm", mp4: "hero-story.mp4" } }, "/glade/");
    expect(html).toContain("data-story-video");
    expect(html).toContain('<source data-src="/glade/media/hero-story.webm" type="video/webm">');
    expect(html).not.toMatch(/<source src=/);
    expect(html).not.toContain(" loop");
    expect(html).toContain('poster="/glade/media/hero-story.png"');
    expect(html).toContain("--story-ratio: 1440 / 900");
    expect(html).toContain("data-story-spot");
    expect(html).toContain("data-story-toggle");
    expect(html.match(/<li class="story-step"/g)).toHaveLength(2);
    expect(html).toContain('data-step="ask" data-start="4" data-end="12" data-rect="0.1 0.1 0.5 0.5"');
    // Captions are text in the page, escaped.
    expect(html).toContain(`<p class="story-step-caption">${STORY_CAPTIONS.agent}</p>`);
    expect(html).toContain("Say &quot;hi&quot; &lt;b&gt;");
  });

  it("falls back to the still with plain (disabled) steps when there's no video", () => {
    const html = renderStory(story, { spec: spec("hero-story"), found: { still } }, "/glade/");
    expect(html).toContain("data-story-static");
    expect(html).toContain("<picture");
    expect(html).not.toContain("data-story-toggle");
    expect(html).toContain("disabled");
  });
});

describe("injectStory", () => {
  it("replaces the story tag", () => {
    expect(injectStory("<p>a</p><glade-story></glade-story>", () => "[story]")).toBe("<p>a</p>[story]");
  });
});
