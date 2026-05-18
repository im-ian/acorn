import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "../lib/useTranslation";

interface ImageLightboxProps {
  image: { src: string; alt?: string } | null;
  onClose: () => void;
}

/**
 * Fullscreen image viewer triggered from markdown `<img>` clicks. Uses a
 * dedicated portal so it renders above any other Modal (e.g. the PR detail
 * panel) and avoids stacking-context surprises. Backdrop click, Escape, and
 * the close button all dismiss; the "Open in browser" button hands the URL
 * to Tauri's opener so users can save / share the original.
 */
export function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  const t = useTranslation();
  // The lightbox is the topmost overlay when it's open. Setting the
  // `acorn-image-preview-open` flag on <body> lets useDialogShortcuts in
  // underlying dialogs (e.g. the PR detail modal) bail out of their Escape
  // handler so the lightbox dismisses first — keydown listeners on `window`
  // capture-phase always fire in registration order, so the older listener
  // can't be preempted without this signal.
  useEffect(() => {
    if (!image) return;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    body.dataset.acornImagePreviewOpen = "1";

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, { capture: true });

    return () => {
      body.style.overflow = previousOverflow;
      delete body.dataset.acornImagePreviewOpen;
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [image, onClose]);

  if (!image) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("imageLightbox.imagePreview")}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      <div className="absolute right-3 top-3 flex items-center gap-1">
        <button
          type="button"
          aria-label={t("imageLightbox.openInBrowser")}
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(image.src);
          }}
          className="rounded p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <ExternalLink size={16} />
        </button>
        <button
          type="button"
          aria-label={t("imageLightbox.close")}
          onClick={onClose}
          className="rounded p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <X size={18} />
        </button>
      </div>
      <img
        src={image.src}
        alt={image.alt ?? ""}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[90vw] cursor-default rounded border border-white/10 object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}
