/**
 * Opening transcript images large (I-110): `useImageLightbox(images)` gives a message's images an
 * `open(index)` and the `ui/Lightbox` to render next to them; ← / → step through the images of
 * that message only.
 */
import { useMemo, useState } from "preact/hooks";
import type { ImageBlock } from "@glade/protocol";
import { Lightbox } from "@/ui";

export function imageSrc(image: Pick<ImageBlock, "mimeType" | "data">): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function useImageLightbox(images: readonly Pick<ImageBlock, "mimeType" | "data">[]) {
  const [index, setIndex] = useState<number | null>(null);
  const sources = useMemo(() => images.map((img) => ({ src: imageSrc(img) })), [images]);
  const lightbox = index === null ? null : <Lightbox images={sources} index={index} onIndexChange={setIndex} />;
  return { open: (i: number) => setIndex(i), lightbox };
}
