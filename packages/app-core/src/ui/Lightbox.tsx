/**
 * Full-window image viewer (I-110): a dark backdrop with one image fitted to the window (never
 * scaled above its natural size). Esc, a click outside the image or × closes it; ← / → (and the
 * side buttons) step through `images`; "Copy image" puts it on the clipboard as PNG (hidden where
 * the async clipboard can't take images). Built on Radix Dialog like ui/Dialog.tsx, so focus is
 * trapped while open and returns to the thumbnail that opened it.
 *
 * The backdrop is dark in both themes (like Quick Look), so the colours here are fixed.
 *
 *   const [index, setIndex] = useState<number | null>(null);
 *   <Lightbox images={[{ src }]} index={index} onIndexChange={setIndex} />
 */
import { useRef, useState } from "preact/hooks";
import * as RadixDialog from "@radix-ui/react-dialog";
import { Check, ChevronLeft, ChevronRight, Copy, X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { cn } from "@glade/app-core/lib/cn";

export interface LightboxImage {
  /** Any URL an `<img>` can show (data URLs included). */
  src: string;
  alt?: string;
}

export interface LightboxProps {
  images: readonly LightboxImage[];
  /** The image shown; `null` = closed. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
}

/** Whether this browser can put an image on the clipboard. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/** The image as a PNG blob (clipboards take PNG); other formats are redrawn on a canvas. */
async function pngBlob(src: string): Promise<Blob> {
  const blob = await (await fetch(src)).blob();
  if (blob.type === "image/png") return blob;
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't convert the image"))), "image/png"));
}

/** Copies an image; the blob is passed as a promise so Safari keeps the click's user activation. */
export async function copyImageToClipboard(src: string): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob(src) })]);
}

const roundButton =
  "grid size-8 place-items-center rounded-full bg-[rgb(255_255_255/0.14)] text-white/90 outline-none hover:bg-[rgb(255_255_255/0.24)] hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-30 [&_svg]:size-4";

function RoundButton({ label, onClick, disabled, children, class: className }: { label: string; onClick: () => void; disabled?: boolean; children: ComponentChildren; class?: string }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} class={cn(roundButton, className)}>
      {children}
    </button>
  );
}

export function Lightbox({ images, index, onIndexChange }: LightboxProps) {
  const open = index !== null && images.length > 0;
  const i = open ? Math.min(Math.max(index, 0), images.length - 1) : 0;
  const image = images[i];
  const many = images.length > 1;
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const contentRef = useRef<HTMLDivElement>(null);

  const go = (delta: number) => {
    if (!many) return;
    setCopy("idle");
    onIndexChange((i + delta + images.length) % images.length);
  };
  const doCopy = () => {
    if (!image) return;
    copyImageToClipboard(image.src).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
    setTimeout(() => setCopy("idle"), 1500);
  };

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setCopy("idle");
          onIndexChange(null);
        }
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay class="fixed inset-0 z-40 bg-[rgb(0_0_0/0.8)] animate-[pi-fade-in_140ms_ease-out]" />
        <RadixDialog.Content
          ref={contentRef}
          data-testid="lightbox"
          // Focus the viewer itself (keys work, no focus ring on a button); Radix still traps
          // focus and returns it to the thumbnail on close.
          onOpenAutoFocus={(e: Event) => {
            e.preventDefault();
            contentRef.current?.focus();
          }}
          class="fixed inset-0 z-50 flex items-center justify-center outline-none animate-[pi-fade-in_140ms_ease-out] select-none"
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              go(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              go(1);
            }
          }}
          // A click on the stage (anything but the image and the buttons) closes.
          onClick={(e: MouseEvent) => {
            if ((e.target as HTMLElement).closest("img,button")) return;
            onIndexChange(null);
          }}
        >
          <RadixDialog.Title class="sr-only">{many ? `Image ${i + 1} of ${images.length}` : "Image"}</RadixDialog.Title>
          <RadixDialog.Description class="sr-only">Esc closes{many ? "; the arrow keys show the other images" : ""}.</RadixDialog.Description>
          {image && (
            <img
              key={image.src}
              src={image.src}
              alt={image.alt ?? ""}
              class="max-h-[calc(100vh-112px)] max-w-[calc(100vw-128px)] rounded-[6px] object-contain shadow-dialog"
            />
          )}
          <div class="absolute top-3 right-3 flex items-center gap-2">
            {canCopyImages() && (
              <button
                type="button"
                onClick={doCopy}
                class="flex h-8 items-center gap-1.5 rounded-full bg-[rgb(255_255_255/0.14)] px-3 text-[0.92rem] text-white/90 outline-none hover:bg-[rgb(255_255_255/0.24)] hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 [&_svg]:size-3.5"
              >
                {copy === "copied" ? <Check /> : <Copy />}
                {copy === "copied" ? "Copied" : copy === "failed" ? "Couldn't copy" : "Copy image"}
              </button>
            )}
            <RadixDialog.Close asChild>
              <button type="button" aria-label="Close" title="Close" class={roundButton}>
                <X />
              </button>
            </RadixDialog.Close>
          </div>
          {many && (
            <>
              <RoundButton label="Previous image" onClick={() => go(-1)} class="absolute top-1/2 left-4 -translate-y-1/2">
                <ChevronLeft />
              </RoundButton>
              <RoundButton label="Next image" onClick={() => go(1)} class="absolute top-1/2 right-4 -translate-y-1/2">
                <ChevronRight />
              </RoundButton>
              <div class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-[rgb(255_255_255/0.14)] px-2.5 py-0.5 text-[0.88rem] text-white/85 tabular-nums">
                {i + 1} / {images.length}
              </div>
            </>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
