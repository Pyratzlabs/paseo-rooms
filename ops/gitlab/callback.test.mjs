import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { validateArtifact } from "./artifact.mjs";
import { REPOSITORY, verifyRelease } from "./release.mjs";
import {
  triggerAndWait,
  workflowRelease,
} from "../../scripts/gitlab-callback.mjs";
import { deploymentConfig, publicHealth, shellQuote } from "./deploy.mjs";

const sha = "a".repeat(40);
const good = {
  id: 123,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/ci.yml",
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

test("release gate accepts only the official, latest successful main CI run", async () => {
  const fetchImpl = async (url) =>
    json(url.endsWith("/123") ? good : { object: { sha } });
  await verifyRelease(sha, "123", { fetchImpl });
  for (const patch of [
    { event: "pull_request" },
    { head_branch: "feature" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { path: ".github/workflows/fake.yml" },
    { repository: { full_name: "attacker/repo" } },
    { head_repository: { full_name: "attacker/repo" } },
    { id: 456 },
  ]) {
    await assert.rejects(
      verifyRelease(sha, "123", {
        fetchImpl: async (url) =>
          json(
            url.endsWith("/123") ? { ...good, ...patch } : { object: { sha } },
          ),
      }),
    );
  }
  await assert.rejects(
    verifyRelease(sha, "123", {
      fetchImpl: async (url) =>
        json(url.endsWith("/123") ? good : { object: { sha: "b".repeat(40) } }),
    }),
    /superseded/,
  );
  await assert.rejects(verifyRelease("../../wrong", "123", { fetchImpl }));
  await assert.rejects(verifyRelease(sha, "123/other", { fetchImpl }));
  assert.throws(() =>
    workflowRelease({
      repository: { full_name: "other/repo" },
      workflow_run: good,
    }),
  );
});

function simulation(
  statuses,
  {
    jobStatus = "success",
    preflightStatus = 200,
    jobPreflightStatus = 200,
    triggerStatus = 201,
  } = {},
) {
  let time = 0;
  const requests = [];
  const logs = [];
  let polls = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, "error");
    if (url.includes("/pipelines?")) return json([{ id: 99 }], preflightStatus);
    if (url.includes("/pipelines/99/jobs")) return json([], jobPreflightStatus);
    if (options.method === "POST")
      return json({ id: 42, ref: "main" }, triggerStatus);
    if (url.includes("/42/jobs"))
      return json([
        { id: 1, name: "deploy-relay", status: "failed" },
        { id: 2, name: "deploy-relay", status: jobStatus },
      ]);
    return json({
      id: 42,
      ref: "main",
      status: statuses[Math.min(polls++, statuses.length - 1)],
    });
  };
  return {
    requests,
    logs,
    options: {
      fetchImpl,
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
      timeoutMs: 30,
      intervalMs: 10,
      report: (text) => logs.push(text),
    },
  };
}
const request = {
  sha,
  runId: "123",
  projectId: "85629452",
  token: "deploy-secret",
  dryRun: true,
};

test("callback preflights read permissions, sends typed inputs, and waits for the actual job", async () => {
  const s = simulation(["pending", "running", "success"]);
  const result = await triggerAndWait(request, s.options);
  assert.equal(result.pipelineId, 42);
  assert.equal(result.dryRun, true);
  const post = s.requests.find((x) => x.options.method === "POST");
  assert.equal(
    post.url,
    "https://gitlab.com/api/v4/projects/85629452/pipeline",
  );
  assert.equal(post.options.headers["PRIVATE-TOKEN"], "deploy-secret");
  const body = JSON.parse(post.options.body);
  assert.deepEqual(body, {
    ref: "main",
    inputs: { github_sha: sha, github_run_id: "123", dry_run: "true" },
  });
  for (const { options } of s.requests)
    assert.equal(options.headers["PRIVATE-TOKEN"], "deploy-secret");
  assert.equal(s.requests.filter((x) => x.options.method === "POST").length, 1);
  assert.ok(s.requests[0].url.includes("/pipelines?"));
  assert.ok(s.logs.every((line) => !line.includes("deploy-secret")));
});

test("missing read/job permissions never trigger a deployment", async () => {
  for (const patch of [{ preflightStatus: 401 }, { jobPreflightStatus: 403 }]) {
    const s = simulation(["success"], patch);
    await assert.rejects(triggerAndWait(request, s.options), /preflight/);
    assert.equal(
      s.requests.filter((x) => x.options.method === "POST").length,
      0,
    );
  }
});

test("failed, skipped, blocked and timed-out pipelines cannot report success", async () => {
  for (const status of ["failed", "canceled", "skipped", "manual", "running"]) {
    const s = simulation([status]);
    await assert.rejects(triggerAndWait(request, s.options));
  }
  const s = simulation(["success"], { jobStatus: "skipped" });
  await assert.rejects(triggerAndWait(request, s.options), /did not succeed/);
  const denied = simulation(["success"], { triggerStatus: 403 });
  await assert.rejects(
    triggerAndWait(request, denied.options),
    /trigger returned/,
  );
  assert.equal(
    denied.requests.filter((x) => x.options.method === "POST").length,
    1,
  );
});

const configuration = {
  RELEASE_SHA: sha,
  RELEASE_RUN_ID: "123",
  DEPLOY_DRY_RUN: "false",
  CI_JOB_ID: "500",
  ROOMS_DOMAIN: "rooms.example.com",
  ROOMS_HOSTNAMES: "rooms.example.com,old.example.com",
  RELAY_AUTH_MODE: "open",
  DEPLOY_SSH_TARGET: "deployer@192.168.193.100",
};
test("deployment rejects command injection, unsafe capacity and ambiguous flags", () => {
  assert.equal(
    deploymentConfig(configuration).environment.RELAY_MAX_HOSTS,
    "256",
  );
  for (const patch of [
    { DEPLOY_REMOTE_DIR: "/home/a/../root" },
    { DEPLOY_SSH_TARGET: "-oProxyCommand=evil" },
    { ROOMS_DOMAIN: "rooms.example.com;id" },
    { ROOMS_HOSTNAMES: "other.example" },
    { RELAY_MAX_HOSTS: "1e3" },
    { RELAY_MAX_HOSTS: "0" },
    { RELAY_MAX_HOSTS: "9007199254740992" },
    { DEPLOY_DRY_RUN: "maybe" },
    { CI_JOB_ID: "../other" },
  ])
    assert.throws(() => deploymentConfig({ ...configuration, ...patch }));
  assert.equal(shellQuote("one'two"), "'one'\"'\"'two'");
});

test("public health requires the exact deployment marker and working WSS", async () => {
  let opens = 0;
  class Socket {
    constructor() {
      opens++;
    }
    addEventListener(type, handler) {
      if (type === "open") queueMicrotask(handler);
    }
    close() {}
  }
  await publicHealth("rooms.example.com", "open", {
    sha,
    deploymentId: "500",
    websocket: Socket,
    sleep: async () => {},
    fetchImpl: async (url) =>
      json(
        url.includes("/assets/")
          ? { sha, deploymentId: "500" }
          : { registration: "open" },
      ),
  });
  assert.equal(opens, 1);
  await assert.rejects(
    publicHealth("rooms.example.com", "open", {
      sha,
      deploymentId: "500",
      websocket: Socket,
      sleep: async () => {},
      fetchImpl: async (url) =>
        json(
          url.includes("/assets/")
            ? { sha: "b".repeat(40), deploymentId: "500" }
            : { registration: "open" },
        ),
    }),
  );
  assert.equal(
    opens,
    1,
    "stale discovery/metadata must never reach the WSS success path",
  );
});

test("artifacts cannot alias credential files through directory, nested or hard links", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "artifact-confinement-"));
  try {
    const root = path.join(scratch, "artifact");
    for (const dir of ["deploy", "public", "src/relay"])
      mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
      path.join(root, "release.json"),
      JSON.stringify({ sha, runId: "123" }),
    );
    validateArtifact(root);
    const credential = path.join(scratch, "dummy-credential");
    writeFileSync(credential, "synthetic canary only");
    symlinkSync(credential, path.join(root, "public", "leak"));
    assert.throws(() => validateArtifact(root), /symlink/);
    rmSync(path.join(root, "public", "leak"));
    linkSync(credential, path.join(root, "public", "leak"));
    assert.throws(() => validateArtifact(root), /hard link/);
    rmSync(path.join(root, "public", "leak"));
    rmSync(path.join(root, "public"), { recursive: true });
    symlinkSync(scratch, path.join(root, "public"));
    assert.throws(() => validateArtifact(root), /symlink/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("unsupported private-key mode fails closed rather than skipping WSS", async () => {
  assert.throws(
    () =>
      deploymentConfig({
        ...configuration,
        RELAY_AUTH_MODE: "key",
        RELAY_KEY: "dummy",
      }),
    /access policy/,
  );
  await assert.rejects(
    publicHealth("rooms.example.com", "key", {}),
    /open relay only/,
  );
});
