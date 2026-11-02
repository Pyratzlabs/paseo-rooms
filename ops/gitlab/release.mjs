/** Trusted release gate, copied into the private deployment repository. */
export const REPOSITORY = "Pyratzlabs/paseo-rooms";
export const WORKFLOW_PATH = ".github/workflows/ci.yml";

export function releaseIdentity(sha, runId) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Invalid release SHA");
  if (!/^[1-9][0-9]{0,14}$/.test(String(runId ?? "")))
    throw new Error("Invalid GitHub CI run ID");
  return { sha, runId: String(runId) };
}

export async function githubJson(endpoint, { fetchImpl = fetch, token } = {}) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(
    `https://api.github.com/repos/${REPOSITORY}/${endpoint}`,
    {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`GitHub verification returned HTTP ${response.status}`);
  return response.json();
}

export async function verifyRelease(sha, runId, options = {}) {
  const release = releaseIdentity(sha, runId);
  const run = await githubJson(`actions/runs/${release.runId}`, options);
  if (
    String(run.id) !== release.runId ||
    run.head_sha !== sha ||
    run.head_branch !== "main" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.path !== WORKFLOW_PATH ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY
  )
    throw new Error(
      "Release is not a successful push-to-main CI run for the official repository",
    );
  const ref = await githubJson("git/ref/heads/main", options);
  if (ref.object?.sha !== sha)
    throw new Error("Release was superseded by a newer main commit");
  return release;
}
