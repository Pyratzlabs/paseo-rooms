import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

test("all GitLab jobs target the dedicated paseo-rooms runner", () => {
  const jobs = ["test", "deploy"];

  for (const job of jobs) {
    assert.match(
      config,
      new RegExp(`^${job}:\\n[\\s\\S]*?^  tags:\\n    - paseo-rooms$`, "m"),
      `${job} must be tagged for the dedicated runner`,
    );
  }
});

test("the LAN deploy reconciles the live deployment and verifies it", () => {
  assert.match(config, /DEPLOY_REMOTE_DIR:-\/home\/deployer\/paseo-rooms/);
  assert.match(config, /compose\.lan\.yml up -d --build/);
  assert.match(config, /for attempt in \\?\$\(seq 1 15\)/);
  assert.match(config, /curl -fsS http:\/\/127\.0\.0\.1:8080\//);
});

test("SSH host identity is pinned through a CI variable", () => {
  assert.match(config, /DEPLOY_SSH_KNOWN_HOSTS/);
  assert.doesNotMatch(config, /StrictHostKeyChecking accept-new/);
});

test("file-based SSH keys retain a trailing newline", () => {
  assert.match(config, /printf '\\n' >> ~\/\.ssh\/id_deploy/);
});
