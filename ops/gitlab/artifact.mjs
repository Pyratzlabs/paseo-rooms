import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

/** Artifacts enter a credentialed job: reject filesystem aliases before reading. */
export function confinedTree(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink())
    throw new Error("Deployment tree contains a symlink");
  if (stat.isDirectory()) {
    for (const entry of readdirSync(root)) confinedTree(path.join(root, entry));
  } else if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("Deployment tree contains a special file or hard link");
  }
}

export function validateArtifact(root) {
  confinedTree(root);
  if (!lstatSync(root).isDirectory())
    throw new Error("Artifact root must be a directory");
  const entries = readdirSync(root).sort();
  if (
    JSON.stringify(entries) !==
    JSON.stringify(["deploy", "public", "release.json", "src"])
  )
    throw new Error("Unexpected deployment artifact entries");
  for (const directory of ["deploy", "public", "src/relay"])
    if (!lstatSync(path.join(root, directory)).isDirectory())
      throw new Error("Artifact directory missing");
  if (!lstatSync(path.join(root, "release.json")).isFile())
    throw new Error("Artifact identity must be a regular file");
}
