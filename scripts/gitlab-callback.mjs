import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  REPOSITORY,
  githubJson,
  releaseIdentity,
  verifyRelease,
} from "../ops/gitlab/release.mjs";

export function workflowRelease(event) {
  const run = event?.workflow_run;
  if (event?.repository?.full_name !== REPOSITORY || !run)
    throw new Error("Unexpected deployment workflow event");
  // The full independent check below also verifies this run through GitHub's API.
  return { sha: run.head_sha, runId: String(run.id) };
}

export async function triggerAndWait(
  { sha, runId, projectId, token, dryRun = false },
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    timeoutMs = 45 * 60_000,
    intervalMs = 10_000,
    report = console.log,
  } = {},
) {
  if (!/^[1-9][0-9]{0,14}$/.test(String(projectId)))
    throw new Error("Invalid GitLab project ID");
  if (!token) throw new Error("GitLab callback credentials are missing");
  releaseIdentity(sha, runId);
  if (typeof dryRun !== "boolean") throw new Error("Invalid dry-run flag");
  const api = `https://gitlab.com/api/v4/projects/${projectId}`;
  // Prove the read credential works before starting any deployment.
  const preflight = await fetchImpl(`${api}/pipelines?per_page=1`, {
    headers: { "PRIVATE-TOKEN": token },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!preflight.ok)
    throw new Error(
      `GitLab read credential preflight returned HTTP ${preflight.status}`,
    );
  const recent = await preflight.json();
  if (!Array.isArray(recent))
    throw new Error("Invalid GitLab pipeline listing");
  if (recent.length) {
    if (!Number.isSafeInteger(recent[0].id) || recent[0].id < 1)
      throw new Error("Invalid GitLab pipeline listing");
    const jobs = await fetchImpl(
      `${api}/pipelines/${recent[0].id}/jobs?per_page=1`,
      {
        headers: { "PRIVATE-TOKEN": token },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!jobs.ok)
      throw new Error(
        `GitLab job permission preflight returned HTTP ${jobs.status}`,
      );
  }
  // Never retry this POST: an uncertain response may already have created a pipeline.
  const triggered = await fetchImpl(`${api}/pipeline`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        github_sha: sha,
        github_run_id: String(runId),
        dry_run: String(dryRun),
      },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!triggered.ok)
    throw new Error(`GitLab trigger returned HTTP ${triggered.status}`);
  const pipeline = await triggered.json();
  if (
    !Number.isSafeInteger(pipeline.id) ||
    pipeline.id < 1 ||
    pipeline.ref !== "main"
  )
    throw new Error("GitLab returned an invalid pipeline identity");
  const url = `https://gitlab.com/pyratzlabs/software/paseo-rooms/-/pipelines/${pipeline.id}`;
  report(`${dryRun ? "Dry-run" : "Deployment"} pipeline: ${url}`);
  const deadline = now() + timeoutMs;
  async function get(suffix) {
    const response = await fetchImpl(
      `${api}/pipelines/${pipeline.id}${suffix}`,
      {
        headers: { "PRIVATE-TOKEN": token },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new Error(`GitLab status returned HTTP ${response.status}; ${url}`);
    return response.json();
  }
  while (now() < deadline) {
    const current = await get("");
    if (current.id !== pipeline.id || current.ref !== "main")
      throw new Error("GitLab pipeline identity changed");
    if (["failed", "canceled", "skipped", "manual"].includes(current.status))
      throw new Error(`GitLab pipeline ${current.status}: ${url}`);
    if (current.status === "success") {
      const jobs = await get("/jobs?per_page=100&include_retried=true");
      const job = jobs
        .filter((item) => item.name === "deploy-relay")
        .sort((a, b) => b.id - a.id)[0];
      if (job?.status !== "success")
        throw new Error(`Deployment job did not succeed: ${url}`);
      report(
        `${dryRun ? "Dry-run validation" : "Relay deployment"} succeeded: ${url}`,
      );
      return { pipelineId: pipeline.id, url, dryRun };
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for GitLab deployment: ${url}`);
}

async function main() {
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const githubOptions = { token: env.GITHUB_TOKEN };
  let release;
  let dryRun;
  if (env.GITHUB_EVENT_NAME === "workflow_run") {
    release = workflowRelease(event);
    dryRun = false;
  } else if (
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF === "refs/heads/main"
  ) {
    const runs = await githubJson(
      `actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${env.GITHUB_SHA}&per_page=20`,
      githubOptions,
    );
    const run = runs.workflow_runs?.find(
      (item) => item.conclusion === "success" && item.status === "completed",
    );
    if (!run)
      throw new Error("No successful main CI run exists for this revision");
    release = { sha: env.GITHUB_SHA, runId: String(run.id) };
    dryRun = true;
  } else throw new Error("Deployment is restricted to official main releases");
  await verifyRelease(release.sha, release.runId, githubOptions);
  const report = (message) => {
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, message + "\n\n");
  };
  await triggerAndWait(
    {
      ...release,
      projectId: env.GITLAB_PROJECT_ID,
      token: env.GITLAB_DEPLOY_TOKEN,
      dryRun,
    },
    { report },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "GitLab deployment callback failed. Check the linked pipeline and workflow credentials.",
    );
    process.exitCode = 1;
  });
