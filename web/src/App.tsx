import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  roomSocket,
  type RoomInfo,
  type RoomQuestion,
  type StreamEvent,
} from "./api";
import {
  appendLiveItem,
  projectStream,
  projectTimeline,
  type DisplayItem,
} from "./timeline";
import { Timeline } from "./components/Timeline";
import { Composer } from "./components/Composer";

function tokenFromPath(): string | null {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts[0] === "r" && parts.length >= 2 ? parts[1] : null;
}

export default function App() {
  const token = tokenFromPath();
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [questions, setQuestions] = useState<RoomQuestion[]>([]);
  const [state, setState] = useState<"connecting" | "live" | "reconnecting">(
    "connecting",
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const retry = useRef(1000);
  const timer = useRef<number | null>(null);
  const streamPosition = useRef(0);
  const continueAssistant = useRef(false);

  const sync = useCallback(async () => {
    if (!token) return;
    const [nextRoom, entries] = await Promise.all([
      api.room(token),
      api.history(token),
    ]);
    setRoom(nextRoom);
    setQuestions(nextRoom.questions ?? []);
    setItems(projectTimeline(entries));
    setWorking(nextRoom.agent?.status === "running");
    continueAssistant.current = false;
  }, [token]);

  useEffect(() => {
    if (!token) {
      setFatal(true);
      return;
    }
    let disposed = false;
    let socket: WebSocket | null = null;
    const connect = () => {
      socket = roomSocket(token);
      socket.onopen = () => {
        retry.current = 1000;
        setState("live");
        void sync().catch(() => !disposed && setFatal(true));
      };
      socket.onmessage = (message) => {
        try {
          const frame = JSON.parse(message.data) as {
            type?: string;
            event?: StreamEvent;
          };
          if (frame.type !== "stream" || !frame.event) return;
          const event = frame.event;
          if (event.type === "turn_started") {
            setWorking(true);
            continueAssistant.current = false;
          }
          if (
            ["turn_completed", "turn_canceled", "turn_failed"].includes(
              event.type,
            )
          ) {
            setWorking(false);
            continueAssistant.current = false;
          }
          if (event.type === "permission_requested" && event.request)
            setQuestions((current) =>
              current.some((question) => question.id === event.request!.id)
                ? current
                : [...current, event.request!],
            );
          if (event.type === "permission_resolved" && event.requestId)
            setQuestions((current) =>
              current.filter((question) => question.id !== event.requestId),
            );
          const projected = projectStream(event, streamPosition.current++);
          if (projected) {
            setItems((current) =>
              appendLiveItem(current, projected, continueAssistant.current),
            );
            continueAssistant.current = projected.kind === "assistant";
          } else if (event.type !== "turn_started") {
            continueAssistant.current = false;
          }
        } catch {
          setError("Received an unreadable live update.");
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setState("reconnecting");
        timer.current = window.setTimeout(connect, retry.current);
        retry.current = Math.min(retry.current * 2, 15_000);
      };
      socket.onerror = () => socket?.close();
    };
    void sync()
      .then(connect)
      .catch(() => setFatal(true));
    return () => {
      disposed = true;
      socket?.close();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [sync, token]);

  async function send(message: string, name: string) {
    if (!name) {
      setError("Add a display name before sending.");
      throw new Error("display name required");
    }
    if (!token) return;
    setError(null);
    try {
      await api.message(token, message, name);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === "429"
          ? "You have sent several messages; please try again in a minute."
          : "Your message could not be sent. Please try again.",
      );
      throw cause;
    }
  }

  async function answer(question: RoomQuestion, actionId: string) {
    if (!token) return;
    setAnswering(question.id);
    setError(null);
    try {
      await api.answer(token, question.id, actionId);
      setQuestions((current) =>
        current.filter((value) => value.id !== question.id),
      );
    } catch {
      setError("That choice could not be sent. Please try again.");
    } finally {
      setAnswering(null);
    }
  }

  if (fatal)
    return (
      <main className="room-error">
        <h1>Invalid or expired share link</h1>
        <p>Ask the host for a new link.</p>
      </main>
    );
  const liveText =
    state === "live"
      ? "live"
      : state === "reconnecting"
        ? "reconnecting…"
        : "connecting…";
  return (
    <div className="app">
      <header className="room-header">
        <div className="header">
          <div className="mark" aria-hidden="true">
            P
          </div>
          <div className="title-wrap">
            <h1>{room?.label || "Shared session"}</h1>
            <div className="status">
              {[room?.agent?.provider, room?.agent?.status]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <span className={`live ${state}`} aria-live="polite">
            <i className="dot" aria-hidden="true" />
            {liveText}
          </span>
        </div>
      </header>
      <main className="timeline" aria-busy={!room}>
        <div className="conversation">
          <Timeline
            items={items}
            questions={questions}
            onAnswer={answer}
            answering={answering}
          />
          {working && (
            <div className="working">
              <i className="pulse" />
              Agent is working…
            </div>
          )}
        </div>
      </main>
      <Composer onSend={send} error={error} />
    </div>
  );
}
