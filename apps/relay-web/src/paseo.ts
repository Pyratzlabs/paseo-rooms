import {
  createPaseoClient,
  type PaseoAgentHandle,
  type PaseoAgentStream,
  type PaseoClient,
} from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  buildRoomQuestionUpdatedInput,
  projectRoomQuestion,
  roomQuestionActionBehavior,
  type RoomQuestion,
  type RoomQuestionResponse,
} from "./questions.js";

const PASEO_URL = process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
const PASEO_PASSWORD = process.env.PASEO_PASSWORD;

let client: PaseoClient | null = null;
let connecting: Promise<PaseoClient> | null = null;
let permissionClient: DaemonClient | null = null;
let connectionEpoch = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryWake: (() => void) | null = null;

/** True once the daemon connection has been established at least once. */
export function isConnected(): boolean {
  return client !== null;
}

async function connect(): Promise<PaseoClient> {
  const c = createPaseoClient({
    url: PASEO_URL,
    password: PASEO_PASSWORD,
    reconnect: { enabled: true },
  });
  await c.connect();
  return c;
}

function waitForRetry(delay: number): Promise<void> {
  return new Promise((resolve) => {
    retryWake = resolve;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryWake = null;
      resolve();
    }, delay);
  });
}

async function closeQuietly(
  value: { close(): Promise<void> } | null,
): Promise<void> {
  if (!value) return;
  try {
    await value.close();
  } catch {
    // Best-effort shutdown; callers are already leaving the local runtime.
  }
}

export async function closePaseoConnections(): Promise<void> {
  connectionEpoch += 1;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryWake?.();
  retryWake = null;

  const activeClient = client;
  const activePermissionClient = permissionClient;
  client = null;
  connecting = null;
  permissionClient = null;
  handles.clear();

  await Promise.all([
    closeQuietly(activeClient),
    closeQuietly(activePermissionClient),
  ]);
}

/**
 * Connect to the daemon, retrying forever with backoff in the background if
 * it's unreachable. Resolves once connected and only rejects if the managed
 * local room runtime is explicitly stopped. Safe to call repeatedly (e.g. from
 * a boot loop) — concurrent callers share one attempt.
 */
export async function ensureConnected(): Promise<PaseoClient> {
  if (client) return client;
  if (!connecting) {
    const epoch = connectionEpoch;
    const state: { attempt?: Promise<PaseoClient> } = {};
    const clearIfCurrent = () => {
      if (connecting === state.attempt) connecting = null;
    };
    state.attempt = (async () => {
      let delay = 1000;
      for (;;) {
        try {
          const c = await connect();
          if (epoch !== connectionEpoch) {
            await closeQuietly(c);
            throw new Error("Paseo daemon connection stopped");
          }
          client = c;
          clearIfCurrent();
          return c;
        } catch (err) {
          if (epoch !== connectionEpoch) {
            clearIfCurrent();
            throw err;
          }
          console.error(
            `could not connect to Paseo daemon (retrying in ${Math.round(delay / 1000)}s):`,
            err instanceof Error ? err.message : err,
          );
          await waitForRetry(delay);
          if (epoch !== connectionEpoch) {
            clearIfCurrent();
            throw new Error("Paseo daemon connection stopped");
          }
          delay = Math.min(delay * 2, 30_000);
        }
      }
    })();
    connecting = state.attempt;
  }
  return connecting;
}

/** Get the client, connecting (and blocking the caller) if needed. Used by
 * scripts (share.ts, e2e.ts) that want the old throw-on-failure behavior. */
export async function getClient(): Promise<PaseoClient> {
  if (client) return client;
  return connect().then((c) => {
    client = c;
    return c;
  });
}

const handles = new Map<string, PaseoAgentHandle>();

export async function getAgentHandle(
  agentId: string,
): Promise<PaseoAgentHandle> {
  const c = await getClient();
  let handle = handles.get(agentId);
  if (!handle) {
    handle = c.agents.ref(agentId);
    handles.set(agentId, handle);
  }
  return handle;
}

export interface TimelineEntry {
  item: unknown;
  timestamp: string;
}

/**
 * Pages backwards from the tail until the beginning of the timeline (or `cap`
 * entries), so a fresh browser gets the whole conversation.
 */
export async function fetchFullHistory(
  agentId: string,
  cap = 1000,
): Promise<TimelineEntry[]> {
  const agent = await getAgentHandle(agentId);
  const pageSize = 200;
  let page = await agent.timeline.refetch({
    direction: "tail",
    limit: pageSize,
    projection: "projected",
  });
  const entries = [...page.entries];
  while (page.hasOlder && page.startCursor && entries.length < cap) {
    page = await agent.timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: pageSize,
      projection: "projected",
    });
    entries.unshift(...page.entries);
  }
  return entries.map((e) => ({ item: e.item, timestamp: e.timestamp }));
}

export type StreamHandler = (event: PaseoAgentStream) => void;

export async function subscribeAgent(
  agentId: string,
  handler: StreamHandler,
): Promise<() => void> {
  const agent = await getAgentHandle(agentId);
  return agent.timeline.subscribe(handler);
}

export async function sendToAgent(
  agentId: string,
  text: string,
): Promise<void> {
  const agent = await getAgentHandle(agentId);
  await agent.send(text);
}

export async function agentInfo(
  agentId: string,
): Promise<{
  title: string | null;
  status: string | null;
  provider: string | null;
} | null> {
  const agent = await getAgentHandle(agentId);
  const result = await agent.refresh();
  if (!result) return null;
  const { title, status, provider } = result.agent as {
    title?: string | null;
    status?: string | null;
    provider?: string | null;
  };
  return {
    title: title ?? null,
    status: status ?? null,
    provider: provider ?? null,
  };
}

export async function listRoomQuestions(
  agentId: string,
): Promise<RoomQuestion[]> {
  const agent = await getAgentHandle(agentId);
  const snapshot = await agent.refresh();
  const pending = snapshot?.agent.pendingPermissions ?? [];
  return pending.flatMap((request) => {
    const question = projectRoomQuestion(request);
    return question ? [question] : [];
  });
}

/** Re-read the live permission request before responding; never trust browser input. */
export async function answerRoomQuestion(
  agentId: string,
  requestId: string,
  response: { actionId?: unknown; answers?: RoomQuestionResponse["answers"] },
): Promise<boolean> {
  const agent = await getAgentHandle(agentId);
  const snapshot = await agent.refresh();
  const request = snapshot?.agent.pendingPermissions.find(
    (pending) => pending.id === requestId,
  );
  if (!request) return false;
  const updatedInput = buildRoomQuestionUpdatedInput(request, response);
  const actionId = response.actionId;
  const behavior = updatedInput
    ? "allow"
    : roomQuestionActionBehavior(request, actionId);
  if (!behavior) return false;
  if (!permissionClient) {
    permissionClient = new DaemonClient({
      url: PASEO_URL,
      password: PASEO_PASSWORD,
      clientType: "cli",
      clientId: "paseo-rooms",
    });
    await permissionClient.connect();
  }
  await permissionClient.respondToPermission(
    agentId,
    requestId,
    updatedInput
      ? { behavior: "allow", updatedInput }
      : { behavior, selectedActionId: actionId as string },
  );
  return true;
}
