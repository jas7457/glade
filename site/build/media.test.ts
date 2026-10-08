import { describe, expect, it } from "vitest";
import {
  MEDIA,
  findFiles,
  focusLayout,
  focusOptions,
  injectFocus,
  injectMedia,
  parseFocusJson,
  posterUrl,
  renderFocus,
  renderMedia,
  variantWidths,
  type MediaSpec,
} from "./media.ts";

const spec = (name: string): MediaSpec => MEDIA.find((m) => m.name === name)!;
const still = { file: "agents.png", width: 2880, height: 1800, variants: [] };

describe("findFiles", () => {
  it("picks the still and both videos for a name, case-insensitively", () => {
    const files = ["hero.PNG", "hero.webm", "hero.mp4", "hero-old.png", "agents.png"];
    expect(findFiles("hero", files)).toEqual({ still: "hero.PNG", webm: "hero.webm", mp4: "hero.mp4" });
    expect(findFiles("agents", files)).toEqual({ still: "agents.png", webm: undefined, mp4: undefined });
    expect(findFiles("search", files)).toEqual({ still: undefined, webm: undefined, mp4: undefined });
  });
});

describe("variantWidths", () => {
  it("never upscales and always includes the capped natural width", () => {
    expect(variantWidths("mac", 2880)).toEqual([960, 1600, 2400, 2880]);
    expect(variantWidths("mac", 1440)).toEqual([960, 1440]);
    expect(variantWidths("iphone", 1206)).toEqual([480, 800, 1206]);
    expect(variantWidths("iphone", 1290)).toEqual([480, 800, 1206]);
  });
});

describe("renderMedia", () => {
  it("renders a labelled placeholder with the capture's aspect ratio when the file is missing", () => {
    const html = renderMedia(spec("agents"), {}, "/glade/");
    expect(html).toContain('data-state="placeholder"');
    expect(html).toContain("aspect-ratio: 2880 / 1800");
    expect(html).toContain("Placeholder: agents screenshot");
    expect(renderMedia(spec("iphone-chat"), {}, "/glade/")).toContain("aspect-ratio: 1206 / 2622");
  });

  it("renders nothing for a missing optional capture", () => {
    expect(renderMedia(spec("composer"), {}, "/glade/")).toBe("");
  });

  it("renders a lazy picture with WebP variants and the image's own size", () => {
    const html = renderMedia(spec("agents"), { still: { ...still, variants: [{ file: "opt/agents-960.webp", width: 960 }] } }, "/glade/");
    expect(html).toContain('data-state="real"');
    expect(html).toContain('srcset="/glade/media/opt/agents-960.webp 960w"');
    expect(html).toContain('src="/glade/media/agents.png" width="2880" height="1800"');
    expect(html).toContain('loading="lazy"');
  });

  it("renders a video whose sources load later, with the poster", () => {
    const html = renderMedia(spec("hero"), { still: { ...still, file: "hero.png" }, webm: "hero.webm", mp4: "hero.mp4" }, "/glade/");
    expect(html).toContain('data-kind="video"');
    expect(html).toContain('poster="/glade/media/hero.png"');
    expect(html).toContain('<source data-src="/glade/media/hero.webm" type="video/webm">');
    expect(html).toContain('preload="none"');
    expect(html).not.toMatch(/<source src=/);
  });

  it("shows a video's poster as an image until the video itself exists", () => {
    const html = renderMedia(spec("search"), { still: { ...still, file: "search.png" } }, "/glade/");
    expect(html).toContain('data-kind="image"');
    expect(html).toContain("<picture");
  });

  it("escapes alt text", () => {
    const html = renderMedia({ ...spec("agents"), alt: 'A "quoted" <b>' }, {}, "/");
    expect(html).toContain("A &quot;quoted&quot; &lt;b&gt;");
  });
});

describe("posterUrl", () => {
  it("prefers a WebP at least 1600px wide", () => {
    const variants = [960, 1600, 2400].map((w) => ({ file: `opt/hero-${w}.webp`, width: w }));
    expect(posterUrl({ ...still, variants }, "/glade/")).toBe("/glade/media/opt/hero-1600.webp");
    expect(posterUrl(still, "/glade/")).toBe("/glade/media/agents.png");
  });
});

describe("injectMedia", () => {
  it("replaces every media tag and leaves the rest alone", () => {
    const html = `<p>a</p><glade-media name="hero"></glade-media><glade-media name="agents"></glade-media>`;
    expect(injectMedia(html, (name) => `[${name}]`)).toBe("<p>a</p>[hero][agents]");
  });
});

describe("parseFocusJson", () => {
  it("keeps well-formed rectangles and drops the rest", () => {
    const json = JSON.stringify({ agents: { x: 1, y: 2, w: 3, h: 4 }, bad: { x: 1, y: 2, w: 0, h: 4 }, worse: "no", partial: { x: 1 } });
    expect(parseFocusJson(json)).toEqual({ agents: { x: 1, y: 2, w: 3, h: 4 } });
    expect(parseFocusJson("not json")).toEqual({});
  });
});

describe("focusLayout", () => {
  const agents = { x: 484, y: 301, w: 740, h: 217 };

  it("sizes the focus asset at about 1.1x app size on a 1160px stage and keeps a strip of the window uncovered", () => {
    const l = focusLayout(agents, { side: "right" });
    expect(l.back).toEqual({ x: 28, y: 0, w: 72, h: 45 });
    expect(l.front.w * 11.6).toBeGreaterThanOrEqual(agents.w * 1.1);
    // The window shows at least 15% to the right of the focus asset and 6% above it.
    expect(l.front.x + l.front.w).toBeLessThanOrEqual(85);
    expect(l.front.y).toBeGreaterThanOrEqual(6);
    expect(l.height).toBeGreaterThanOrEqual(l.front.y + l.front.h - 0.01);
  });

  it("mirrors for a window on the left and caps tall regions", () => {
    const tall = { x: 850, y: 36, w: 590, h: 560 };
    const l = focusLayout(tall, { side: "left" });
    expect(l.back.x).toBe(0);
    expect(l.front.x).toBeGreaterThanOrEqual(15);
    expect(l.front.h).toBeLessThanOrEqual(58);
    expect(l.front.x + l.front.w).toBeLessThanOrEqual(100);
  });

  it("follows the region down: a composer strip sits at the window's bottom", () => {
    const l = focusLayout({ x: 476, y: 797, w: 749, h: 98 }, { side: "right" });
    expect(l.front.y).toBeGreaterThan(l.back.h * 0.75);
  });
});

describe("renderFocus", () => {
  const full = { spec: spec("agents"), found: { still: { ...still, variants: [{ file: "opt/agents-1600.webp", width: 1600 }] } } };
  const focus = { spec: spec("agents-focus"), found: { still: { file: "agents-focus.png", width: 2220, height: 651, variants: [] } } };
  const rect = { x: 484, y: 301, w: 740, h: 217 };

  it("puts the focus asset in front of the dimmed, decorative full window", () => {
    const html = renderFocus("agents", { full, focus, rect }, { side: "right" }, "/glade/");
    expect(html).toContain('data-focus-stage="agents"');
    expect(html).toContain('data-focus-rect="0.3361 0.3344 0.5139 0.2411"');
    expect(html).toMatch(/--dfw:[\d.]+;/);
    expect(html).toContain('<div class="focus-back" data-focus-back aria-hidden="true">');
    expect(html).toContain('alt=""');
    expect(html).toContain('src="/glade/media/agents-focus.png"');
    expect(html.indexOf("data-focus-back")).toBeLessThan(html.indexOf("data-focus-front"));
  });

  it("shows only a video's poster behind, never a second video", () => {
    const sub = { spec: spec("subagents"), found: { still: { ...still, file: "subagents.png" }, webm: "subagents.webm", mp4: "subagents.mp4" } };
    const subFocus = { spec: spec("subagents-focus"), found: { still: { ...still, file: "subagents-focus.png" }, webm: "subagents-focus.webm" } };
    const html = renderFocus("subagents", { full: sub, focus: subFocus, rect }, { side: "left" }, "/glade/");
    expect(html.match(/<video/g)).toHaveLength(1);
    expect(html).toContain("subagents-focus.webm");
    expect(html).not.toContain("subagents.webm");
  });

  it("falls back to the full capture without a focus asset or rectangle, and to a placeholder without either", () => {
    const noFocus = renderFocus("agents", { full, focus: { spec: spec("agents-focus"), found: {} }, rect }, { side: "right" }, "/glade/");
    expect(noFocus).toContain("focus-stage--plain");
    expect(noFocus).toContain('src="/glade/media/agents.png"');
    const noRect = renderFocus("agents", { full, focus }, { side: "right" }, "/glade/");
    expect(noRect).toContain("focus-stage--plain");
    const nothing = renderFocus("agents", { full: { spec: spec("agents"), found: {} } }, { side: "right" }, "/glade/");
    expect(nothing).toContain('data-state="placeholder"');
  });

  it("renders nothing for a missing optional capture", () => {
    const html = renderFocus("composer", { full: { spec: spec("composer"), found: {} }, focus: { spec: spec("composer-focus"), found: {} } }, { side: "right" }, "/");
    expect(html).toBe("");
  });
});

describe("injectFocus", () => {
  it("expands each stage with its attributes and keeps the extra layers for injectMedia", () => {
    const html = `<glade-focus name="agents" side="left" front="60" class="x">\n  <glade-media name="agents-settings-focus"></glade-media>\n</glade-focus>`;
    const out = injectFocus(html, (tag) => {
      const o = focusOptions(tag);
      return `[${tag.name} ${o.side} ${o.frontWidth} ${o.className} ${o.extra}]`;
    });
    expect(out).toBe('[agents left 60 x <glade-media name="agents-settings-focus"></glade-media>]');
  });
});
