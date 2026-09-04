import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
