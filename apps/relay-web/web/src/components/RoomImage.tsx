import { useEffect, useRef, useState } from "react";
import type { RoomImage as ImageMetadata } from "../../../shared/room-attachments.js";
import type { RoomImageCache } from "../image-cache.js";

export function RoomImage({
  image,
  cache,
}: {
  image: ImageMetadata;
  cache: RoomImageCache | null;
}) {
  const [url, setUrl] = useState<string | null>(null),
    [failed, setFailed] = useState(false),
    [open, setOpen] = useState(false),
    [attempt, setAttempt] = useState(0);
  const container = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    let started = false;
    let generation = 0;
    setUrl(null);
    setFailed(false);
    const load = () => {
      if (started) return;
      started = true;
      const current = ++generation;
      if (!cache) {
        setFailed(true);
        return;
      }
      void cache
        .load(image)
        .then((value) => {
          if (active && generation === current) setUrl(value);
        })
        .catch(() => {
          if (active && generation === current) setFailed(true);
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
        else {
          generation++;
          started = false;
          setUrl(null);
        }
      },
      { rootMargin: "100px" },
    );
    if (container.current) observer.observe(container.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [cache, image, attempt]);
  useEffect(() => {
    if (open) {
      const element = dialog.current;
      element?.showModal();
      return () => element?.close();
    }
  }, [open]);
  function close() {
    dialog.current?.close();
    setOpen(false);
    button.current?.focus();
  }
  return (
    <div className="room-image" ref={container}>
      {url ? (
        <button
          type="button"
          className="image-thumbnail"
          ref={button}
          aria-label="Enlarge attached image"
          onClick={() => {
            void cache
              ?.load(image)
              .then((value) => {
                setUrl(value);
                setOpen(true);
              })
              .catch(() => setFailed(true));
          }}
        >
          <img
            src={url}
            alt="Attached image"
            width={image.width}
            height={image.height}
            onError={() => {
              cache?.invalidate(image);
              setUrl(null);
              setFailed(true);
            }}
          />
        </button>
      ) : (
        <div className="image-placeholder" role="status">
          {failed ? (
            <>
              Image unavailable{" "}
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </>
          ) : (
            "Loading image…"
          )}
        </div>
      )}
      {open && (
        <dialog
          className="image-dialog"
          ref={dialog}
          aria-label="Attached image"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <button
            type="button"
            className="image-close"
            onClick={close}
            autoFocus
            aria-label="Close image"
          >
            Close ×
          </button>
          <img src={url ?? undefined} alt="Attached image enlarged" />
        </dialog>
      )}
    </div>
  );
}
