import { useEffect, useRef, useState } from "react";

export function Composer({
  onSend,
  error,
}: {
  onSend: (message: string) => Promise<void>;
  error: string | null;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`;
  }, [message]);

  async function submit() {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await onSend(message.trim());
      setMessage("");
    } finally {
      setSending(false);
    }
  }

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
        {error && (
          <div className="send-error" role="alert">
            {error}
          </div>
        )}
        <div className="fields">
          <textarea
            ref={textarea}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
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
          <button type="submit" disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
        <p className="help">Enter to send · Shift + Enter for a new line</p>
      </div>
    </form>
  );
}
