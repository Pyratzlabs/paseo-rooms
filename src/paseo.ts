import {
  createPaseoClient,
  type PaseoAgentHandle,
  type PaseoAgentStream,
  type PaseoClient,
} from "@getpaseo/client";

const PASEO_URL = process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
const PASEO_PASSWORD = process.env.PASEO_PASSWORD;

let client: PaseoClient | null = null;

export async function getClient(): Promise<PaseoClient> {
  if (!client) {
    client = createPaseoClient({
      url: PASEO_URL,
      password: PASEO_PASSWORD,
      reconnect: { enabled: true },
    });
    await client.connect();
  }
  return client;
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
