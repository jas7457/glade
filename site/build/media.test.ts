import { describe, expect, it } from "vitest";
import { MEDIA, findFiles, injectMedia, posterUrl, renderMedia, variantWidths, type MediaSpec } from "./media.ts";

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
