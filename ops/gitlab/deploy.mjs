import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateArtifact } from "./artifact.mjs";
import { REPOSITORY, releaseIdentity, verifyRelease } from "./release.mjs";

export function deploymentConfig(env) {
  const release = releaseIdentity(env.RELEASE_SHA, env.RELEASE_RUN_ID);
  if (!["true", "false"].includes(env.DEPLOY_DRY_RUN))
    throw new Error("Invalid dry-run flag");
  const dryRun = env.DEPLOY_DRY_RUN === "true";
  const directory = env.DEPLOY_REMOTE_DIR || "/home/deployer/paseo-rooms";
  if (!/^(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/.test(directory))
    throw new Error("Invalid deployment directory");
  const domain = env.ROOMS_DOMAIN;
  const hostname = (value) =>
    typeof value === "string" &&
    value.length <= 253 &&
    value.split(".").length > 1 &&
    value
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (!hostname(domain)) throw new Error("Invalid primary hostname");
  const hostnames = env.ROOMS_HOSTNAMES || domain;
  const hosts = hostnames.split(",");
  if (hosts.length > 10 || !hosts.includes(domain) || !hosts.every(hostname))
    throw new Error("Invalid TLS hostnames");
  const mode = env.RELAY_AUTH_MODE || "key";
  if (mode !== "open") throw new Error("Invalid relay access policy");
  const capacity = (name, fallback) => {
    const value = env[name] ?? fallback;
    if (
      !/^[0-9]+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1
    )
      throw new Error(`Invalid ${name}`);
    return value;
  };
  const target = env.DEPLOY_SSH_TARGET;
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$/.test(target || ""))
    throw new Error("Invalid private SSH target");
  const environment = {
    ROOMS_DOMAIN: domain,
    ROOMS_HOSTNAMES: hostnames,
    RELAY_AUTH_MODE: mode,
    RELAY_MAX_HOSTS: capacity("RELAY_MAX_HOSTS", "256"),
    RELAY_MAX_HOSTS_PER_SOURCE: capacity("RELAY_MAX_HOSTS_PER_SOURCE", "32"),
  };

  const deploymentId = env.CI_JOB_ID;
  if (!dryRun && !/^[1-9][0-9]{0,14}$/.test(deploymentId || ""))
    throw new Error("Invalid deployment identity");
  return { ...release, dryRun, directory, target, environment, deploymentId };
}

export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export async function publicHealth(
  domain,
  mode,
  {
    sha,
    deploymentId,
    fetchImpl = fetch,
    websocket = globalThis.WebSocket,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (mode !== "open")
    throw new Error(
      "This deployment workflow supports the hosted open relay only",
    );
  const deadline = Date.now() + 120_000;
  for (let attempt = 0; attempt < 60 && Date.now() < deadline; attempt++) {
    try {
      const response = await fetchImpl(
        `https://${domain}/.well-known/paseo-rooms`,
        { redirect: "error", signal: AbortSignal.timeout(5000) },
      );
      const marker = await fetchImpl(
        `https://${domain}/assets/deployments/${deploymentId}.json`,
        { redirect: "error", signal: AbortSignal.timeout(5000) },
      );
      const identity = marker.ok ? await marker.json() : null;
      if (
        response.ok &&
        (await response.json()).registration === mode &&
        identity?.sha === sha &&
        identity?.deploymentId === deploymentId
      ) {
        // Private relays require a host key; verify their HTTPS policy without a credential-bearing URL.
        if (mode === "open")
          await new Promise((resolve, reject) => {
            const ws = new websocket(`wss://${domain}/host`);
            const timer = setTimeout(() => {
              ws.close();
              reject(new Error("WSS timed out"));
            }, 5000);
            ws.addEventListener(
              "open",
              () => {
                clearTimeout(timer);
                ws.close();
                resolve();
              },
              { once: true },
            );
            ws.addEventListener(
              "error",
              () => {
                clearTimeout(timer);
                ws.close();
                reject(new Error("WSS failed"));
              },
              { once: true },
            );
          });
        return;
      }
    } catch {
      /* Retry while proxy TLS certificates and the new container settle. */
    }
    await sleep(2000);
  }
  throw new Error("Public relay HTTPS/WSS verification failed");
}

async function main() {
  const cfg = deploymentConfig(process.env);
  const recovering = process.argv.includes("--recover");
  const checkpoint = path.resolve(".relay-deploy-attempted");
  if (recovering && (!existsSync(checkpoint) || cfg.dryRun)) return;
  if (recovering && readFileSync(checkpoint, "utf8") !== cfg.deploymentId)
    throw new Error("Checkpoint belongs to another deployment job");
  if (!recovering) await verifyRelease(cfg.sha, cfg.runId);
  if (!recovering) {
    validateArtifact(path.resolve("release-artifact"));
    const artifact = JSON.parse(
      readFileSync("release-artifact/release.json", "utf8"),
    );
    if (artifact.sha !== cfg.sha || artifact.runId !== cfg.runId)
      throw new Error("Build artifact identity mismatch");
    if (cfg.dryRun) {
      console.log(
        `Dry run verified and built ${cfg.sha}; no VM changes were made.`,
      );
      return;
    }
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "rooms-deploy-"));
  chmodSync(scratch, 0o700);
  const run = (file, args, options = {}) =>
    execFileSync(file, args, {
      stdio: "inherit",
      timeout: 120_000,
      ...options,
    });
  const trustedRemote = readFileSync(
    fileURLToPath(new URL("./remote.py", import.meta.url)),
    "utf8",
  );
  try {
    const secret = (name) => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is missing`);
      return existsSync(value) ? readFileSync(value, "utf8") : value;
    };
    const key = path.join(scratch, "key");
    const known = path.join(scratch, "known_hosts");
    writeFileSync(key, secret("DEPLOY_SSH_PRIVATE_KEY").trimEnd() + "\n", {
      mode: 0o600,
    });
    writeFileSync(known, secret("DEPLOY_SSH_KNOWN_HOSTS").trimEnd() + "\n", {
      mode: 0o600,
    });
    const ssh = [
      "-F",
      "/dev/null",
      "-i",
      key,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${known}`,
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
    ];
    const remote = (action, environment) =>
      run(
        "ssh",
        [...ssh, cfg.target, `python3 -c ${shellQuote(trustedRemote)}`],
        {
          input: JSON.stringify({
            action,
            directory: cfg.directory,
            deploymentId: cfg.deploymentId,
            sha: cfg.sha,
            environment,
          }),
          stdio: ["pipe", "pipe", "inherit"],
          encoding: "utf8",
          timeout: 14 * 60_000,
        },
      );
    if (recovering) {
      remote("abort");
      remote("rollback");
      rmSync(checkpoint, { force: true });
      return;
    }
    writeFileSync(checkpoint, cfg.deploymentId, { mode: 0o600 });
    try {
      const prepared = JSON.parse(remote("prepare"));
      const markerDir = path.resolve(
        "release-artifact/public/assets/deployments",
      );
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(
        path.join(markerDir, `${cfg.deploymentId}.json`),
        JSON.stringify({ sha: cfg.sha, deploymentId: cfg.deploymentId }),
      );
      const environment = {
        ...cfg.environment,
        RELAY_TRUSTED_PROXY_ADDRESSES: prepared.proxy,
      };
      for (const relative of ["deploy", "src/relay", "public"]) {
        run("rsync", [
          "-az",
          "--timeout=60",
          "--delete",
          "--exclude=.env*",
          "--exclude=.deploy*",
          "--exclude=.active-release.yml",
          "--exclude=.rollback-image.yml",
          "-e",
          ["ssh", ...ssh].map(shellQuote).join(" "),
          `${path.resolve("release-artifact")}/${relative}/`,
          `${cfg.target}:${cfg.directory}/.relay-staging/${cfg.deploymentId}/apps/relay-web/${relative}/`,
        ]);
      }
      remote("activate", environment);
      await publicHealth(
        cfg.environment.ROOMS_DOMAIN,
        cfg.environment.RELAY_AUTH_MODE,
        { sha: cfg.sha, deploymentId: cfg.deploymentId },
      );
      remote("commit");
      rmSync(checkpoint, { force: true });
    } catch {
      console.error(
        "Deployment verification failed; restoring the previous relay image and configuration.",
      );
      remote("abort");
      remote("rollback");
      rmSync(checkpoint, { force: true });
      throw new Error(
        "Relay deployment failed and the previous release was restored",
      );
    }
    console.log(`Deployed and verified ${cfg.sha}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Private relay deployment failed; check verification and runner access.",
    );
    process.exitCode = 1;
  });
