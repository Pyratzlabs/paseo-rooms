import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { confinedTree, validateArtifact } from "./artifact.mjs";
import { REPOSITORY, verifyRelease } from "./release.mjs";

const { RELEASE_SHA: sha, RELEASE_RUN_ID: runId } = process.env;
await verifyRelease(sha, runId);
const scratch = mkdtempSync(path.join(tmpdir(), "rooms-build-"));
const source = path.join(scratch, "source");
const run = (args, cwd) =>
  execFileSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
try {
  run(["git", "init", source]);
  run([
    "git",
    "-C",
    source,
    "remote",
    "add",
    "origin",
    `https://github.com/${REPOSITORY}.git`,
  ]);
  run(["git", "-C", source, "fetch", "--depth=1", "origin", sha]);
  run(["git", "-C", source, "checkout", "--detach", sha]);
  run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], source);
  run(["npm", "run", "build:docs"], source);
  run(["npm", "run", "build:web"], source);
  const artifact = path.resolve("release-artifact");
  rmSync(artifact, { recursive: true, force: true });
  mkdirSync(artifact);
  for (const relative of ["deploy", "src/relay", "public"]) {
    confinedTree(path.join(source, "apps/relay-web", relative));
    cpSync(
      path.join(source, "apps/relay-web", relative),
      path.join(artifact, relative),
      { recursive: true },
    );
  }
  writeFileSync(
    path.join(artifact, "release.json"),
    JSON.stringify({ sha, runId }),
  );
  validateArtifact(artifact);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
