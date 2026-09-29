/**
 * Opening transcript images large (I-110): `useImageLightbox(images)` gives a message's images an
 * `open(index)` and the `ui/Lightbox` to render next to them; ← / → step through the images of
 * that message only.
 */
import { useState } from "preact/hooks";
import { Lightbox } from "@/ui";
import { useImageSrcs, type ImageLike } from "./image-src";

/** `src` of an inline image (composer attachments); transcript images use `useImageSrcs` (I-157). */
export function imageSrc(image: Pick<ImageLike, "mimeType" | "data">): string {
  return `data:${image.mimeType};base64,${image.data ?? ""}`;
}

export function useImageLightbox(images: readonly ImageLike[]) {
  const [index, setIndex] = useState<number | null>(null);
  const srcs = useImageSrcs(images);
  const sources = srcs.map((src) => ({ src: src ?? "" }));
  const lightbox = index === null ? null : <Lightbox images={sources} index={index} onIndexChange={setIndex} />;
  return { open: (i: number) => setIndex(i), lightbox };
}
