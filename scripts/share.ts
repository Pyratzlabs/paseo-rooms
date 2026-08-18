/* Host-side helper: mint a share room for an existing agent.
   Usage:
     npm run share                 # list recent agents, then re-run with an id
     npm run share -- <agent-id>   # id may be a unique prefix */
import fs from "node:fs";
import path from "node:path";
import { getClient } from "../src/paseo.js";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

async function main(): Promise<void> {
  const arg = process.argv[2];
  const client = await getClient();

  if (!arg) {
    const page = await client.agents.list({
      page: { limit: 20 },
      sort: [{ key: "updated_at", direction: "desc" }],
    });
    console.log("Recent agents (pass an id to share one):\n");
    for (const { agent } of page.entries) {
      const title = (agent.title ?? "").replace(/\s+/g, " ").slice(0, 60);
      console.log(`  ${agent.id}  [${agent.status}]  ${title}`);
    }
    await client.close();
    return;
  }

  // Allow unique id prefixes, like the paseo CLI does.
  const page = await client.agents.list({ page: { limit: 200 } });
  const matches = page.entries.filter(({ agent }) => agent.id.startsWith(arg));
  if (matches.length !== 1) {
    console.error(matches.length === 0 ? `no agent matches "${arg}"` : `"${arg}" is ambiguous (${matches.length} matches)`);
    await client.close();
    process.exit(1);
  }
  const agent = matches[0].agent;

  const adminToken = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();
  const res = await fetch(`${BASE_URL}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ agentId: agent.id }),
  });
  if (!res.ok) {
    console.error(`room creation failed (${res.status}):`, await res.text());
    await client.close();
    process.exit(1);
  }
  const { url } = (await res.json()) as { url: string };
  console.log(`Sharing agent: ${(agent.title ?? agent.id).slice(0, 70)}`);
  console.log(`\n  ${url}\n`);
  console.log("Send this link to your collaborator. Anyone with the link can chat with this agent.");
  await client.close();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
