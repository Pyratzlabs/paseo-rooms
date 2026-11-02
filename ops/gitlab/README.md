# Private GitLab relay deployment

GitHub owns source, PRs, CI and Pages. The existing private GitLab project
`pyratzlabs/software/paseo-rooms` owns only the relay deployment pipeline and VM
credentials. No public PR job runs on its self-hosted runner, and the VM's SSH
port does not need public exposure.

## Trust and installation

Copy `pipeline.yml` to `.gitlab-ci.yml` on the private project's protected `main`
branch, together with `artifact.mjs`, `build.mjs`, `deploy.mjs`, `release.mjs` and `remote.py` at
these same `ops/gitlab/` paths. These are trusted deployment configuration,
maintained independently from the requested application revision. Existing
GitLab application history is archived; the pipeline fetches the exact public
GitHub release rather than using that old code.

Before giving GitHub a deployment token, set and verify the GitLab project setting
`ci_pipeline_variables_minimum_override_role=no_one_allowed`. Inputs are the
only caller-controlled parameters: GitHub SHA, CI run ID, and an explicit
`true`/`false` dry-run choice (default `true`). Typed inputs alone do not stop
API callers from supplying dangerous variable overrides.

Keep `main` protected. The pipeline accepts only API-created pipelines on that
protected branch. Its runner uses the `paseo-rooms` tag. Disable shared runners
for this private deployment project if they are not needed.

## Credentials and configuration

In GitHub's **relay-production** environment, restricted to `main`, configure:

- `GITLAB_DEPLOY_TOKEN`: a GitLab fine-grained personal token restricted to
  `pyratzlabs/software/paseo-rooms`, with **Pipeline → Create** and
  **Pipeline → Read**. The same token creates the pipeline through
  `POST /projects/:id/pipeline` and reads pipeline/job status. Track its
  expiration and replace it before expiry. The callback preflights read
  permissions before POST.

Set it interactively (the token is not included in shell history):

```sh
gh secret set GITLAB_DEPLOY_TOKEN --repo Pyratzlabs/paseo-rooms --env relay-production
```

This workflow supports the hosted open relay only; key-mode destinations fail
closed rather than skipping an authenticated WebSocket check. Manual GitHub
dispatch is always a dry run; production is triggered by successful main CI.

The token is project-scoped, not branch-scoped. Private pipeline rules,
disabled variable overrides and independent release checks enforce the
deployment boundary. No separate pipeline trigger token is needed.

In GitLab, keep `DEPLOY_SSH_PRIVATE_KEY`, `DEPLOY_SSH_KNOWN_HOSTS` and any legacy
`RELAY_KEY` **protected and scoped to environment `production`**. Remove their
old global-scope copies once the deployment-only pipeline is installed. The
build job has no production environment and must receive no VM credentials.
Paseo's reviewed main source and its build dependencies are trusted to build
application artifacts, not to receive production SSH secrets. `--ignore-scripts`
is not a sandbox: subsequent builds execute application code and dependencies.

Non-secret GitLab configuration:

```dotenv
DEPLOY_SSH_TARGET=deployer@192.168.193.100
DEPLOY_REMOTE_DIR=/home/deployer/paseo-rooms
ROOMS_DOMAIN=paseo-rooms.pyratz.com
ROOMS_HOSTNAMES=paseo-rooms.pyratz.com,paseo-rooms.pyratzlabs.fr
RELAY_AUTH_MODE=open
RELAY_MAX_HOSTS=256
RELAY_MAX_HOSTS_PER_SOURCE=32
```

The VM needs Docker Compose, rsync, Python3 and the existing `nginx-proxy` on
Docker network `web`. Its exact current proxy IP is discovered through pinned
SSH; arbitrary forwarded-header sources are not trusted. HTTPS routing and
certificate issuance must work for the advertised hostnames.

## Release and status checks

GitHub requests a deployment only after successful push-to-main CI from the
same official repository. GitLab independently verifies the exact run's repo,
workflow path, source event, SHA, conclusion and latest-main ref. It verifies
again after obtaining the deployment resource lock, before activation after the
VM build, and before committing after public health checks. A superseded release
observed before activation is rejected; one observed before commit is rolled
back. Public PR SHAs and arbitrary refs are rejected by the release gate.

Freshness checks are point-in-time observations. The VM deployment lock does not
lock GitHub's `main` branch, so a push can occur immediately after the final
check. This workflow does not promise that the running release always matches
the current branch head; a subsequent successful main CI run requests the next
deployment. New source commits that fail CI do not replace a healthy release.

GitHub waits for both the GitLab pipeline and its actual `deploy-relay` job to
succeed. Failed, cancelled, skipped, blocked and timed-out jobs are not success.
The trigger POST is not retried after an ambiguous network response. A GitHub
poll timeout does not cancel GitLab: inspect the linked pipeline before retrying.

## Dry runs and activation

A dry run builds the verified public commit and checks its artifact identity,
then exits without SSH or VM mutations. The initial live smoke test uses a
previously successful GitHub main CI run and `dry_run=true`.

Artifact trees are checked in both jobs before copy, identity reads or secret
materialization; symbolic links, hard links and special files are rejected.
Uploads go to a per-job staging directory, and promotion into active paths holds
the VM lock. An orphaned upload after failure can only change its old staging
directory, never overwrite restored live configuration.

For a real deployment, a fresh VM checkpoint is owned by the GitLab deployment
job ID, before rsync touches active files. The host lock serializes remote
operations and each Docker command has a timeout. An abort marker prevents a
long build from activating after cancellation. Artifacts are built before the
active environment changes; environment replacement is atomic and preserves
unrelated settings. Deployment pins the built immutable image ID and verifies
that the running container matches it.

An immutable public asset at `/assets/deployments/<job-id>.json` records the
release SHA and deployment ID. The deployment checks that marker, HTTPS discovery
and public WSS before committing the checkpoint. Metadata contains no credentials
or invitation. A different/old relay answering the same discovery mode cannot
satisfy this release check.

Failure before commit restores the matching previous env, compose and image.
A first deployment has no previous image, so rollback finds its relay by Compose
service, deployment ID and revision labels, independent of the Compose project
name. It verifies the image and that the service stopped before recording
successful rollback.
Late recovery never undoes a committed or differently owned deployment. GitLab's
`after_script` retries recovery on cancellation/failure, with script/cleanup time
reserved inside the job timeout. Persistent VM/network failure can prevent
recovery; the job fails and leaves the durable checkpoint for an operator.
Backups under `deploy/.deploy-history/<job-id>/` contain private environment data;
keep their owner-only permissions and prune old terminal checkpoints as part of
VM maintenance. Never delete an active checkpoint.

## Manual recovery

From the failed GitLab deploy job's workspace, `node ops/gitlab/deploy.mjs --recover`
uses the same job ID and credentials to mark abort and restore its checkpoint.
If SSH was lost, restore connectivity first. The VM's
`deploy/.deploy-transaction.json` identifies the pending owner; recovery must
use that owner, not an arbitrary newer job ID. Do not simply overwrite the
checkpoint to unblock a new deployment.

If that workspace has already been removed, use a fresh checkout of the trusted
private deployment configuration on an operator machine that can reach the VM.
Load the production-scoped SSH credentials securely; do not copy them into shell
history or logs. Read the VM checkpoint through pinned SSH and confirm its owner
against the failed GitLab deploy job ID. Set `CI_JOB_ID` to that exact owner,
`RELEASE_SHA` and `RELEASE_RUN_ID` to that pipeline's inputs, and
`DEPLOY_DRY_RUN=false`, together with the non-secret configuration above. Recreate
the local ownership marker and run recovery:

```sh
umask 077
printf '%s' "$CI_JOB_ID" > .relay-deploy-attempted
node ops/gitlab/deploy.mjs --recover
```

Recovery uses the VM's durable checkpoint; it needs no build artifact and does
not rebuild or deploy a release. Never substitute the new recovery job's ID for
the failed owner's ID. Keep the marker if recovery fails, and retry only after
restoring connectivity. Verify the original image and public service afterward.

The production workflow is activated only after this configuration and its
GitHub PR have been reviewed. PR1's site/hostname cutover and any application PR
merges remain separate user actions.
