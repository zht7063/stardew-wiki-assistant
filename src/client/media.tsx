import { useEffect, useRef, useState } from "react";
import { authHeaders } from "./api";

/** Hotlink the wiki first. If that fails, ask our Worker (it caches the file). */
export function useWikiSrc(remote: string | undefined): { src: string; hidden: boolean; onError: () => void } {
  const [src, setSrc] = useState(remote ?? "");
  const [hidden, setHidden] = useState(!remote);
  const triedProxy = useRef(false);
  const blob = useRef<string | null>(null);

  useEffect(() => {
    setSrc(remote ?? "");
    setHidden(!remote);
    triedProxy.current = false;
    return () => {
      if (blob.current) {
        URL.revokeObjectURL(blob.current);
        blob.current = null;
      }
    };
  }, [remote]);

  async function onError() {
    if (!remote || triedProxy.current) {
      setHidden(true);
      return;
    }
    triedProxy.current = true;
    try {
      const response = await fetch(`/api/img?u=${encodeURIComponent(remote)}`, { headers: authHeaders() });
      if (!response.ok) {
        setHidden(true);
        return;
      }
      const data = await response.blob();
      if (!data.type.startsWith("image/")) {
        setHidden(true);
        return;
      }
      const url = URL.createObjectURL(data);
      if (blob.current) URL.revokeObjectURL(blob.current);
      blob.current = url;
      setSrc(url);
      setHidden(false);
    } catch {
      setHidden(true);
    }
  }

  return { src, hidden, onError: () => void onError() };
}

export function ChipImage({ src }: { src: string }) {
  const image = useWikiSrc(src);
  if (image.hidden || !image.src) return null;
  return (
    <img
      className="chip-img"
      src={image.src}
      alt=""
      width={28}
      height={28}
      loading="lazy"
      decoding="async"
      onError={image.onError}
    />
  );
}

export function WikiThumb({ src, label, onOpen }: { src: string; label: string; onOpen: (src: string) => void }) {
  const image = useWikiSrc(src);
  if (image.hidden || !image.src) return null;
  return (
    <button
      type="button"
      className="thumb"
      aria-label={`放大查看${label}的图片`}
      onClick={() => onOpen(image.src)}
    >
      <img src={image.src} alt="" width={56} height={56} loading="lazy" decoding="async" onError={image.onError} />
    </button>
  );
}

export function Lightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={label}>
      <button ref={closeRef} type="button" className="lightbox-hit" aria-label="关闭图片" onClick={onClose}>
        <img src={src} alt={label} />
      </button>
    </div>
  );
}
