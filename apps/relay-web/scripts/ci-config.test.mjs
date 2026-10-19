import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const config = await readFile(
  new URL("../../../.gitlab-ci.yml", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
const relayPackageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const deployScript = await readFile(
  new URL("../deploy/deploy.sh", import.meta.url),
  "utf8",
);
const proxyCompose = await readFile(
  new URL("../deploy/compose.proxy.yml", import.meta.url),
  "utf8",
);

test("proxy deployment restricts its raw HTTP health-check port to loopback", () => {
  const ports = proxyCompose.match(/^    ports:\n((?:      .*\n)+)/m)?.[1];
  assert.ok(ports, "the CI health check requires a local published port");
  const bindings = [...ports.matchAll(/^      - "([^"]+)"$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(bindings, ["127.0.0.1:8080:8080"]);
  assert.match(proxyCompose, /networks:\n      - web/);
  assert.match(proxyCompose, /VIRTUAL_PORT: "8080"/);
});

test("all GitLab jobs target the dedicated paseo-rooms runner", () => {
  const jobs = ["quality", "tests", "plugin-verify", "deploy", "pages"];

  for (const job of jobs) {
    assert.match(
      config,
      new RegExp(`^${job}:\\n[\\s\\S]*?^  tags:\\n    - paseo-rooms$`, "m"),
      `${job} must be tagged for the dedicated runner`,
    );
  }
});

test("the deploy reconciles the live deployment and verifies it", () => {
  assert.match(config, /DEPLOY_REMOTE_DIR:-\/home\/deployer\/paseo-rooms/);
  // Dual-mode: nginx-proxy compose when ROOMS_DOMAIN is set, LAN compose otherwise.
  assert.match(config, /COMPOSE_FILE="compose\.proxy\.yml"/);
  assert.match(config, /COMPOSE_FILE="compose\.lan\.yml"/);
  assert.match(config, /-f \$COMPOSE_FILE up -d --build --remove-orphans/);
  assert.match(config, /ROOMS_DOMAIN=%s/);
  assert.match(config, /apps\/relay-web\/public\//);
  assert.match(config, /needs:\n    - job: quality\n      artifacts: true/);
  assert.match(config, /needs:[\s\S]*?job: tests\n      artifacts: false/);
  assert.match(
    config,
    /needs:[\s\S]*?job: plugin-verify\n      artifacts: false/,
  );
  assert.match(config, /for attempt in \\?\$\(seq 1 15\)/);
  assert.match(
    config,
    /curl -fsS http:\/\/127\.0\.0\.1:8080\/\.well-known\/paseo-rooms/,
  );
});

test("SSH host identity is pinned through a CI variable", () => {
  assert.match(config, /DEPLOY_SSH_KNOWN_HOSTS/);
  assert.doesNotMatch(config, /StrictHostKeyChecking accept-new/);
});

test("file-based SSH keys retain a trailing newline", () => {
  assert.match(config, /printf '\\n' >> ~\/\.ssh\/id_deploy/);
});

test("quality and behavior checks are separate CI jobs", () => {
  for (const command of [
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm run typecheck:web",
    "npm run build:docs",
    "npm run build:web",
  ]) {
    assert.match(
      config,
      new RegExp(
        `^quality:[\\s\\S]*?^    - ${command.replace(/[:]/g, "\\:")}$`,
        "m",
      ),
      `quality must run ${command}`,
    );
  }
  assert.match(
    config,
    /^tests:[\s\S]*?^    - npm run build:docs$/m,
    "tests must build public documentation before exercising relay static serving",
  );
  assert.match(
    config,
    /^tests:[\s\S]*?^    - npm run build:web$/m,
    "tests must build the public room bundle before exercising relay static serving",
  );
  for (const command of [
    "npm run test:relay",
    "npm run test:relay-client",
    "npm run test:e2ee",
    "npm run test:secure-client",
    "npm run test:relay-origin",
    "npm run test:relay-target",
    "npm run test:e2ee-browser",
    "npm run test:name",
    "npm run test:scroll",
    "npm run test:room-ui",
    "npm run test:timeline",
    "npm run test:questions",
    "npm run test:public-events",
    "npm run test:presence",
    "npm run test:ci",
    "npm run test:lock",
  ]) {
    assert.match(
      config,
      new RegExp(
        `^tests:[\\s\\S]*?^    - ${command.replace(/[:]/g, "\\:")}$`,
        "m",
      ),
      `tests must run ${command}`,
    );
  }
  assert.equal(
    packageJson.scripts["format:check"],
    "npm run format:check --workspace @paseo-rooms/relay-web && npm run format:check --workspace @paseo-rooms/docs",
  );
  assert.equal(
    packageJson.scripts.lint,
    "npm run lint --workspace @paseo-rooms/relay-web && npm run lint --workspace @paseo-rooms/docs",
  );
  assert.match(deployScript, /npm run build:docs/);
  assert.match(deployScript, /npm run build:web/);
});

test("GitLab Pages publishes a relay-configured room SPA after verification", () => {
  assert.match(config, /^pages:[\s\S]*?^  stage: deploy$/m);
  assert.match(
    config,
    /VITE_PASEO_ROOMS_RELAY_ORIGIN=https:\/\/paseo-rooms\.pyratzlabs\.fr npm run build:web/,
  );
  assert.match(
    config,
    /cp apps\/relay-web\/public\/room\.html pages-public\/index\.html/,
  );
  assert.match(
    config,
    /cp apps\/relay-web\/public\/room\.html pages-public\/404\.html/,
  );
  assert.match(config, /publish: pages-public/);
  assert.match(
    config,
    /^pages:[\s\S]*?needs:[\s\S]*?job: quality\n      artifacts: false/m,
  );
  assert.match(config, /^pages:[\s\S]*?CI_COMMIT_BRANCH == "main"/m);
});

test("the local room server builds the documentation site before starting", () => {
  assert.match(
    relayPackageJson.scripts.start,
    /npm --prefix \.\.\/docs run build/,
    "a fresh local checkout must generate /docs/ before the landing page links to it",
  );
  assert.match(relayPackageJson.scripts.start, /npm run build:web/);
});

test("verification jobs run for merge request pipelines", () => {
  for (const job of ["quality", "tests", "plugin-verify"]) {
    assert.match(
      config,
      new RegExp(
        `^${job}:[\\s\\S]*?CI_PIPELINE_SOURCE == "merge_request_event"`,
        "m",
      ),
      `${job} must run in an MR pipeline`,
    );
  }
});

test("manual deployment succeeds only when discovery reports the requested mode", () => {
  const verification = deployScript.slice(
    deployScript.indexOf('echo "==> Waiting for https://'),
  );
  assert.ok(verification.startsWith('echo "==> Waiting for https://'));
  const script = `
set -euo pipefail
fail() { echo "$*" >&2; exit 1; }
curl() { printf '%s' "$DISCOVERY_FIXTURE"; return "$CURL_STATUS"; }
sleep() { :; }
${verification}`;
  const cases = [
    { mode: "open", body: '{"registration":"open"}', success: true },
    { mode: "key", body: '{"registration": "key"}', success: true },
    { mode: "open", body: '{"registration":"key"}', success: false },
    { mode: "key", body: '{"registration":"open"}', success: false },
    { mode: "open", body: "not JSON", success: false },
    { mode: "open", body: "{}", success: false },
    {
      mode: "open",
      body: '{"registration":"open"}',
      curlStatus: 22,
      success: false,
    },
  ];
  for (const { mode, body, curlStatus = 0, success } of cases) {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        ROOMS_DOMAIN: "fixture.invalid",
        RELAY_AUTH_MODE: mode,
        DISCOVERY_FIXTURE: body,
        CURL_STATUS: String(curlStatus),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, success, result.stderr);
    if (success) {
      assert.match(result.stdout, /Deploy complete/);
    } else {
      assert.doesNotMatch(result.stdout, /Deploy complete/);
      assert.match(result.stderr, /registration mode.*after 30 attempts/);
    }
  }
});

test("CI schedules only deployments with complete registration and SSH settings", () => {
  const rule = config.match(
    /^deploy:[\s\S]*?^  rules:\n    - if: ([^\n]+)/m,
  )?.[1];
  assert.ok(rule, "deployment rule must be present");
  const defaults = {
    CI_COMMIT_BRANCH: "main",
    DEPLOY_SSH_TARGET: "fixture-host",
    DEPLOY_SSH_PRIVATE_KEY: "fixture-private-key",
    DEPLOY_SSH_KNOWN_HOSTS: "fixture-known-hosts",
    ROOMS_DOMAIN: "private.example.com",
  };
  // Evaluate the actual GitLab rule against fixture variables. Unset variables
  // are null; explicitly empty variables are empty strings in GitLab rules.
  const scheduled = (variables) =>
    Boolean(
      runInNewContext(
        rule.replace(/\$([A-Z_]+)/g, (_, name) =>
          JSON.stringify({ ...defaults, ...variables }[name] ?? null),
        ),
        {},
        { timeout: 1000 },
      ),
    );
  for (const mode of [null, "", "key"]) {
    assert.equal(scheduled({ RELAY_AUTH_MODE: mode }), false);
    assert.equal(
      scheduled({ RELAY_AUTH_MODE: mode, RELAY_KEY: "fixture-key" }),
      true,
    );
  }
  for (const mode of [null, "", "open"]) {
    assert.equal(
      scheduled({
        ROOMS_DOMAIN: "paseo-rooms.pyratzlabs.fr",
        RELAY_AUTH_MODE: mode,
      }),
      true,
    );
  }
  assert.equal(scheduled({ RELAY_AUTH_MODE: "open" }), true);
  assert.equal(
    scheduled({
      ROOMS_DOMAIN: "paseo-rooms.pyratzlabs.fr",
      RELAY_AUTH_MODE: "key",
    }),
    false,
  );
  assert.equal(
    scheduled({ RELAY_AUTH_MODE: "invalid", RELAY_KEY: "fixture-key" }),
    false,
  );
  for (const name of [
    "DEPLOY_SSH_TARGET",
    "DEPLOY_SSH_PRIVATE_KEY",
    "DEPLOY_SSH_KNOWN_HOSTS",
  ]) {
    for (const missing of [null, ""]) {
      assert.equal(
        scheduled({ RELAY_AUTH_MODE: "open", [name]: missing }),
        false,
      );
    }
  }
  assert.equal(
    scheduled({ CI_COMMIT_BRANCH: "feature", RELAY_AUTH_MODE: "open" }),
    false,
  );
});

test("CI remote verification requires a complete successful discovery response", () => {
  const block = config.match(
    /^deploy:[\s\S]*?^  script:\n    - \|\n([\s\S]*?)^  rules:/m,
  )?.[1];
  assert.ok(block);
  // Capture the actual expanded SSH command, then execute only its verification
  // loop with local curl/sleep/docker fixtures. No SSH or deployment is run.
  const capture = spawnSync(
    "sh",
    [
      "-eu",
      "-c",
      `
ssh() { case "$2" in "printf '%s' "*) printf '%s' "$2" ;; esac; }
rsync() { :; }
${block.replace(/^      /gm, "")}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DEPLOY_SSH_TARGET: "fixture-host",
        DEPLOY_REMOTE_DIR: "/fixture",
        ROOMS_DOMAIN: "fixture.invalid",
        RELAY_AUTH_MODE: "open",
        RELAY_KEY: "",
      },
    },
  );
  assert.equal(capture.status, 0, capture.stderr);
  const loop = capture.stdout.match(/ && (for attempt in [\s\S]+)$/)?.[1];
  assert.ok(loop, "remote deployment must verify discovery");
  const cases = [
    { body: '{"registration":"open"}', status: 18, success: false },
    { body: '{"registration":"open"', status: 0, success: false },
    { body: '{"registration":"key"}', status: 0, success: false },
    { body: "not JSON", status: 0, success: false },
    { body: '{"registration":"open"}', status: 0, success: true },
    { body: '{ "registration": "open" }', status: 0, success: true },
  ];
  for (const { body, status, success } of cases) {
    const result = spawnSync(
      "sh",
      [
        "-c",
        `
curl() { printf '%s' "$DISCOVERY_FIXTURE"; return "$CURL_STATUS"; }
sleep() { :; }
docker() {
  # compose --env-file .env -f <file> exec -T relay <command...>
  shift 8
  "$@"
}
${loop}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISCOVERY_FIXTURE: body,
          CURL_STATUS: String(status),
        },
      },
    );
    assert.equal(
      result.status === 0,
      success,
      `curl=${status}, body=${body}: ${result.stderr}`,
    );
  }
});

test("CI selects and persists public or private registration before deploying", () => {
  const block = config.match(
    /^deploy:[\s\S]*?^  script:\n    - \|\n([\s\S]*?)^  rules:/m,
  )?.[1];
  assert.ok(block, "deployment script must be present");
  // Shell functions avoid executing files from a potentially noexec tmpdir.
  // Capture the SSH command as data; never run it against a remote host.
  const script = `
ssh() {
  case "$2" in
    "printf '%s' "*) printf '%s' "$2" > "$POLICY_OUTPUT" ;;
  esac
}
rsync() { :; }
${block.replace(/^      /gm, "")}`;
  const directory = mkdtempSync(join(tmpdir(), "rooms-deploy-policy-"));
  const output = join(directory, "environment");
  const cases = [
    {
      domain: "paseo-rooms.pyratzlabs.fr",
      mode: "",
      key: "",
      expected: "open",
    },
    {
      domain: "private.example.com",
      mode: "",
      key: "fixture-key",
      expected: "key",
    },
    { domain: "", mode: "", key: "fixture-key", expected: "key" },
    { domain: "private.example.com", mode: "open", key: "", expected: "open" },
    {
      domain: "paseo-rooms.pyratzlabs.fr",
      mode: "key",
      key: "fixture-key",
      expected: "key",
    },
    {
      domain: "private.example.com",
      mode: "",
      key: "",
      error: /RELAY_KEY is required/,
    },
    {
      domain: "paseo-rooms.pyratzlabs.fr",
      mode: "invalid",
      key: "",
      error: /RELAY_AUTH_MODE must be/,
    },
  ];
  try {
    for (const { domain, mode, key, expected, error } of cases) {
      rmSync(output, { force: true });
      const result = spawnSync("sh", ["-eu", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          POLICY_OUTPUT: output,
          DEPLOY_SSH_TARGET: "fixture-host",
          DEPLOY_REMOTE_DIR: "/fixture",
          ROOMS_DOMAIN: domain,
          RELAY_AUTH_MODE: mode,
          RELAY_KEY: key,
        },
      });
      if (error) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, error);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const command = readFileSync(output, "utf8");
        const payload = command.match(/^printf '%s' '([^']+)'/);
        assert.ok(payload, "deployment must persist its environment");
        const environment = Buffer.from(payload[1], "base64").toString("utf8");
        assert.match(
          environment,
          new RegExp(`^RELAY_AUTH_MODE=${expected}$`, "m"),
        );
        assert.match(environment, new RegExp(`^RELAY_KEY=${key}$`, "m"));
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
