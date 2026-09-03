import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  roomSocket,
  type RoomInfo,
  type RoomParticipant,
  type RoomQuestion,
  type RoomQuestionAnswer,
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
import { NameGate } from "./components/NameGate";
import { Participants } from "./components/Participants";
import {
  configuredRelayTarget,
  requiresCustomRelayConfirmation,
} from "./relay-origin";
import { shouldFollowTimeline } from "./scroll";
import {
  connectSecureRoom,
  hideSecureInviteFromLocation,
  secureInviteFromLocation,
  type SecureEvent,
} from "./secure-room-client";

function tokenFromPath(): string | null {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts[0] === "r" && parts.length >= 2 ? parts[1] : null;
}

function isParticipant(value: unknown): value is RoomParticipant {
  if (typeof value !== "object" || value === null) return false;
  const participant = value as Partial<RoomParticipant>;
  return (
    typeof participant.id === "string" &&
    typeof participant.name === "string" &&
    (participant.role === "host" || participant.role === "collaborator")
  );
}

export default function App() {
  const token = tokenFromPath();
  const secureInvite = useRef(secureInviteFromLocation(token));
  const secureSession = useRef<Awaited<
    ReturnType<typeof connectSecureRoom>
  > | null>(null);
  const [customRelayConfirmed, setCustomRelayConfirmed] = useState(
    () =>
      !requiresCustomRelayConfirmation(
        secureInvite.current?.relayOrigin,
        configuredRelayTarget(),
      ),
  );
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [questions, setQuestions] = useState<RoomQuestion[]>([]);
  const [participants, setParticipants] = useState<RoomParticipant[]>([
    { id: "host", name: "Host", role: "host" },
  ]);
  const [name, setName] = useState<string | null>(null);
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
  const timeline = useRef<HTMLElement>(null);
  const followTimeline = useRef(true);
  const initiallyScrolled = useRef(false);

  useEffect(() => {
    if (secureInvite.current) hideSecureInviteFromLocation();
  }, []);

  const scrollToLatest = useCallback((force = false) => {
    if (force) followTimeline.current = true;
    window.requestAnimationFrame(() => {
      const element = timeline.current;
      if (!element || (!force && !followTimeline.current)) return;
      element.scrollTop = element.scrollHeight;
      initiallyScrolled.current = true;
    });
  }, []);

  const applyLiveFrame = useCallback((frame: SecureEvent) => {
    if (frame.type === "presence" && Array.isArray(frame.participants)) {
      setParticipants(frame.participants.filter(isParticipant));
      return;
    }
    if (frame.type !== "stream" || !frame.event) return;
    const event = frame.event;
    if (event.type === "turn_started") {
      setWorking(true);
      continueAssistant.current = false;
    }
    if (
      ["turn_completed", "turn_canceled", "turn_failed"].includes(event.type)
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
  }, []);

  useLayoutEffect(() => {
    if (!name || (items.length === 0 && questions.length === 0 && !working))
      return;
    if (!initiallyScrolled.current || followTimeline.current) scrollToLatest();
  }, [items, name, questions, scrollToLatest, working]);

  const sync = useCallback(async () => {
    if (!token) return;
    if (secureInvite.current) return;
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
    if (!customRelayConfirmed) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (!name) return;
      if (secureInvite.current) {
        void connectSecureRoom(secureInvite.current, name, {
          onWelcome(welcome) {
            retry.current = 1000;
            setState("live");
            setRoom(welcome.room);
            setQuestions(welcome.room.questions ?? []);
            setParticipants(welcome.participants.filter(isParticipant));
            setItems(projectTimeline(welcome.history));
            setWorking(welcome.working);
            continueAssistant.current = false;
          },
          onEvent: applyLiveFrame,
          onClose() {
            if (disposed) return;
            setState("reconnecting");
            secureSession.current = null;
            timer.current = window.setTimeout(connect, retry.current);
            retry.current = Math.min(retry.current * 2, 15_000);
          },
          onError() {
            setError("Received an unreadable live update.");
          },
        })
          .then((session) => {
            secureSession.current = session;
          })
          .catch(() => !disposed && setFatal(true));
        return;
      }
      socket = roomSocket(token);
      socket.onopen = () => {
        retry.current = 1000;
        setState("live");
        socket?.send(JSON.stringify({ type: "hello", name }));
        void sync().catch(() => !disposed && setFatal(true));
      };
      socket.onmessage = (message) => {
        try {
          const frame = JSON.parse(message.data) as {
            type?: string;
            event?: StreamEvent;
            participants?: unknown[];
          };
          if (frame.type === "presence" && Array.isArray(frame.participants)) {
            applyLiveFrame({
              type: "presence",
              participants: frame.participants.filter(isParticipant),
            });
            return;
          }
          if (frame.type === "stream" && frame.event)
            applyLiveFrame({ type: "stream", event: frame.event });
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
      secureSession.current?.close();
      secureSession.current = null;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [applyLiveFrame, customRelayConfirmed, name, sync, token]);

  async function send(message: string) {
    if (!name) return;
    if (!token) return;
    setError(null);
    try {
      if (secureInvite.current) {
        const session = secureSession.current;
        if (!session) throw new Error("secure room is not ready");
        await session.sendMessage(message);
      } else {
        await api.message(token, message, name);
      }
      scrollToLatest(true);
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
      if (secureInvite.current) {
        const session = secureSession.current;
        if (!session) throw new Error("secure room is not ready");
        await session.answer(question.id, actionId);
      } else {
        await api.answer(token, question.id, actionId);
      }
      scrollToLatest(true);
      setQuestions((current) =>
        current.filter((value) => value.id !== question.id),
      );
    } catch {
      setError("That choice could not be sent. Please try again.");
    } finally {
      setAnswering(null);
    }
  }

  async function answerPrompts(
    question: RoomQuestion,
    answers: RoomQuestionAnswer[],
  ) {
    if (!token) return;
    setAnswering(question.id);
    setError(null);
    try {
      if (secureInvite.current) {
        const session = secureSession.current;
        if (!session) throw new Error("secure room is not ready");
        await session.answerPrompts(question.id, answers);
      } else {
        await api.answerPrompts(token, question.id, answers);
      }
      scrollToLatest(true);
      setQuestions((current) =>
        current.filter((value) => value.id !== question.id),
      );
    } catch {
      setError("Those answers could not be sent. Please try again.");
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
  if (!customRelayConfirmed && secureInvite.current?.relayOrigin)
    return (
      <main className="room-error relay-confirmation">
        <h1>Connect to a custom relay?</h1>
        <p>
          This link requests a relay other than the one configured for this
          client.
        </p>
        <code>{secureInvite.current.relayOrigin}</code>
        <p>Only continue if you trust the person who shared this link.</p>
        <button type="button" onClick={() => setCustomRelayConfirmed(true)}>
          Connect to this relay
        </button>
      </main>
    );
  if (!name)
    return (
      <div className="app onboarding-app">
        <header className="room-header">
          <div className="header">
            <div className="mark" aria-hidden="true">
              P
            </div>
            <div className="title-wrap">
              <h1>{room?.label || "Shared session"}</h1>
            </div>
          </div>
        </header>
        <NameGate onContinue={setName} />
      </div>
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
      <div className="room-body">
        <Participants participants={participants} />
        <main
          className="timeline"
          aria-busy={!room}
          ref={timeline}
          onScroll={(event) => {
            const element = event.currentTarget;
            followTimeline.current = shouldFollowTimeline(element);
          }}
        >
          <div className="conversation">
            <Timeline
              items={items}
              questions={questions}
              onAnswer={answer}
              onAnswerPrompts={answerPrompts}
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
      </div>
      <Composer onSend={send} error={error} />
    </div>
  );
}
