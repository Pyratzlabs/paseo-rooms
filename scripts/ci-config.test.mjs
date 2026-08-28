import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(
  new URL("../.gitlab-ci.yml", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("all GitLab jobs target the dedicated paseo-rooms runner", () => {
  const jobs = ["quality", "tests", "deploy"];

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
  assert.match(config, /for attempt in \\?\$\(seq 1 15\)/);
  assert.match(config, /curl -sS http:\/\/127\.0\.0\.1:8080\//);
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
  for (const command of [
    "npm run test:relay",
    "npm run test:relay-client",
    "npm run test:name",
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
    "prettier --check .gitlab-ci.yml eslint.config.js package.json scripts/ci-config.test.mjs web",
  );
  assert.equal(packageJson.scripts.lint, "eslint web eslint.config.js");
});
