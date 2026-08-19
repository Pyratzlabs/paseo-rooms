import {
  createPaseoClient,
  type PaseoAgentHandle,
  type PaseoAgentStream,
  type PaseoClient,
} from "@getpaseo/client";

const PASEO_URL = process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
const PASEO_PASSWORD = process.env.PASEO_PASSWORD;

let client: PaseoClient | null = null;
let connecting: Promise<PaseoClient> | null = null;

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

/**
 * Connect to the daemon, retrying forever with backoff in the background if
 * it's unreachable. Never throws; resolves once connected. Safe to call
 * repeatedly (e.g. from a boot loop) — concurrent callers share one attempt.
 */
export async function ensureConnected(): Promise<PaseoClient> {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      let delay = 1000;
      for (;;) {
        try {
          const c = await connect();
          client = c;
          connecting = null;
          return c;
        } catch (err) {
          console.error(
            `could not connect to Paseo daemon (retrying in ${Math.round(delay / 1000)}s):`,
            err instanceof Error ? err.message : err,
          );
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 30_000);
        }
      }
    })();
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

export async function getAgentHandle(agentId: string): Promise<PaseoAgentHandle> {
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
export async function fetchFullHistory(agentId: string, cap = 1000): Promise<TimelineEntry[]> {
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

export async function subscribeAgent(agentId: string, handler: StreamHandler): Promise<() => void> {
  const agent = await getAgentHandle(agentId);
  return agent.timeline.subscribe(handler);
}

export async function sendToAgent(agentId: string, text: string): Promise<void> {
  const agent = await getAgentHandle(agentId);
  await agent.send(text);
}

export async function agentInfo(
  agentId: string,
): Promise<{ title: string | null; status: string | null; provider: string | null } | null> {
  const agent = await getAgentHandle(agentId);
  const result = await agent.refresh();
  if (!result) return null;
  const { title, status, provider } = result.agent as {
    title?: string | null;
    status?: string | null;
    provider?: string | null;
  };
  return { title: title ?? null, status: status ?? null, provider: provider ?? null };
}
