import { useEffect, useRef, useState } from "react";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  isImageMime,
  type SubmissionReceipt,
} from "../../../shared/room-attachments.js";
import { validateImage } from "../../../src/image-validation.js";

export function Composer({
  onSend,
  error,
  images = false,
  connected = true,
}: {
  onSend: (
    message: string,
    file: File | null,
    key: string,
    progress: (value: number) => void,
  ) => Promise<SubmissionReceipt | void>;
  error: string | null;
  images?: boolean;
  connected?: boolean;
}) {
  const [message, setMessage] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<string | null>(null),
    [sending, setSending] = useState(false),
    [progress, setProgress] = useState<number | null>(null),
    [attachmentError, setAttachmentError] = useState<string | null>(null),
    [uncertain, setUncertain] = useState(false),
    [validating, setValidating] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    submissionKey = useRef(crypto.randomUUID().replaceAll("-", "")),
    selection = useRef(0),
    validatingRef = useRef(false),
    sendingRef = useRef(false);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`;
  }, [message]);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
  async function attach(candidate: File) {
    if (sendingRef.current || validatingRef.current || uncertain || !images)
      return;
    validatingRef.current = true;
    setValidating(true);
    const attempt = ++selection.current;
    setAttachmentError(null);
    try {
      if (
        !isImageMime(candidate.type) ||
        candidate.size < 1 ||
        candidate.size > MAX_IMAGE_BYTES
      )
        throw new Error("invalid_image");
      validateImage(
        new Uint8Array(await candidate.arrayBuffer()),
        candidate.type,
      );
      const bitmap = await createImageBitmap(candidate);
      bitmap.close();
      if (attempt === selection.current) {
        setFile(candidate);
        submissionKey.current = crypto.randomUUID().replaceAll("-", "");
      }
    } catch {
      if (attempt === selection.current)
        setAttachmentError(
          "Choose a valid, still PNG, JPEG, or WebP image up to 2 MiB (maximum 8192 px per side and 16 million pixels).",
        );
    } finally {
      if (attempt === selection.current) {
        validatingRef.current = false;
        setValidating(false);
      }
    }
  }
  async function submit() {
    if (
      (!message.trim() && !file) ||
      sendingRef.current ||
      validatingRef.current ||
      !connected
    )
      return;
    sendingRef.current = true;
    setSending(true);
    setProgress(file && !uncertain ? 0 : null);
    setAttachmentError(null);
    try {
      const result = await onSend(
        message.trim(),
        file,
        submissionKey.current,
        setProgress,
      );
      if (result && result.status !== "accepted") {
        setUncertain(result.status !== "rejected");
        setAttachmentError(
          result.status === "rejected"
            ? "The agent declined this message. Your draft is saved."
            : "Delivery is not confirmed. Your draft is saved; check delivery before sending again.",
        );
        if (result.status === "rejected")
          submissionKey.current = crypto.randomUUID().replaceAll("-", "");
        return;
      }
      setMessage("");
      setFile(null);
      setUncertain(false);
      submissionKey.current = crypto.randomUUID().replaceAll("-", "");
    } catch (cause) {
      if (file) {
        const code = cause instanceof Error ? cause.message : "";
        const safe = [
          "room_full",
          "upload_busy",
          "send_busy",
          "rate_limited",
          "invalid_image",
          "invalid_chunk",
          "message_too_large",
        ].includes(code);
        setUncertain(!safe);
        setAttachmentError(
          safe
            ? code === "room_full"
              ? "This room has reached its image limit. Ask the host to create a new room."
              : "The image could not be sent. Your draft is saved; try again shortly."
            : "Delivery is not confirmed. Your draft is saved; check delivery before sending again.",
        );
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      setProgress(null);
    }
  }
  const locked = sending || uncertain || validating;
  return (
    <form
      className="composer"
      aria-label="Send a message"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="composer-inner">
        {(error || attachmentError) && (
          <div className="send-error" role="alert">
            {attachmentError || error}
          </div>
        )}
        {uncertain && !sending && (
          <div className="uncertain-draft">
            <p>
              Sending this image again could duplicate a message. You can
              discard this draft to continue chatting.
            </p>
            <button
              type="button"
              onClick={() => {
                setMessage("");
                setFile(null);
                setUncertain(false);
                setAttachmentError(null);
                submissionKey.current = crypto.randomUUID().replaceAll("-", "");
              }}
            >
              Discard draft
            </button>
          </div>
        )}
        {file && (
          <div className="attachment-preview">
            {preview && <img src={preview} alt="Image ready to attach" />}
            <span>
              {file.name || "Pasted image"}
              <small>{Math.ceil(file.size / 1024)} KiB</small>
            </span>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                selection.current++;
                setFile(null);
                setAttachmentError(null);
              }}
              aria-label="Remove attached image"
            >
              Remove ×
            </button>
          </div>
        )}
        {progress !== null && (
          <div className="upload-progress" role="status">
            <progress value={progress} max={100} />
            <span>
              {progress === 100
                ? "Waiting for agent acceptance…"
                : `Uploading image… ${progress}%`}
            </span>
          </div>
        )}
        <div className="fields">
          {images && (
            <>
              <input
                ref={picker}
                type="file"
                accept={IMAGE_MIME_TYPES.join(",")}
                hidden
                onChange={(event) => {
                  const candidate = event.target.files?.[0];
                  if (candidate) void attach(candidate);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="attach-image"
                disabled={locked || !connected}
                onClick={() => picker.current?.click()}
                aria-label="Attach image"
                title="Attach one image (up to 2 MiB)"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="m9 16 7-7a3 3 0 0 0-4-4L4 13a5 5 0 0 0 7 7l9-9a7 7 0 0 0-10-10L2 9" />
                </svg>
              </button>
            </>
          )}
          <textarea
            ref={textarea}
            value={message}
            disabled={locked}
            onChange={(event) => setMessage(event.target.value)}
            onPaste={(event) => {
              if (!images || locked) return;
              const image = Array.from(event.clipboardData.items).find(
                (item) =>
                  item.kind === "file" && item.type.startsWith("image/"),
              );
              const candidate = image?.getAsFile();
              if (candidate) {
                event.preventDefault();
                void attach(candidate);
              }
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={1}
            placeholder="Message the agent…"
            aria-label="Message the agent"
          />
          <button
            type="submit"
            disabled={
              sending || validating || !connected || (!message.trim() && !file)
            }
          >
            {validating
              ? "Checking image…"
              : sending
                ? "Sending…"
                : uncertain
                  ? "Check delivery"
                  : "Send"}
          </button>
        </div>
        <p className="help">
          Enter to send · Shift + Enter for a new line
          {images ? " · One image up to 2 MiB" : ""}
        </p>
      </div>
    </form>
  );
}
