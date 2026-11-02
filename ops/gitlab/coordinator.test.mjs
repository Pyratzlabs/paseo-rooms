import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
const sha = "a".repeat(40);
const preload = `
import child from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const append=fs.appendFileSync.bind(fs), originalWrite=fs.writeFileSync.bind(fs);
function log(action){append(process.env.CALLS,action+'\\n');}
fs.writeFileSync=function(file,value,options){if(String(file).endsWith('/key'))log('secret-materialized');return originalWrite(file,value,options);};
child.execFileSync=function(file,args,options){
 if(file==='rsync'){
  log('sync');if(!args.at(-1).includes('/.relay-staging/500/'))throw Error('Unsafe active upload');
  if(options.timeout!==120000)throw Error('Unbounded rsync');
  if(process.env.FAULT==='sync')throw Error('SSH upload lost');return '';
 }
 if(file!=='ssh')throw Error('Unexpected command');
 const action=JSON.parse(options.input).action;log(action);
 if(options.timeout!==840000||!args.includes('ServerAliveCountMax=3'))throw Error('Unbounded SSH');
 if(process.env.FAULT==='cancel'&&action==='activate'){process.kill(process.pid,'SIGTERM');return '';}
 if(process.env.FAULT===action||(process.env.FAULT==='rollback'&&['activate','rollback'].includes(action)))throw Error('Simulated private failure');
 return action==='prepare'?JSON.stringify({proxy:'172.18.0.3'}):'';
};
syncBuiltinESMExports();
const timeout=global.setTimeout;global.setTimeout=(callback,ms,...args)=>ms===2000?timeout(callback,0,...args):timeout(callback,ms,...args);
global.fetch=async url=>{
 if(String(url).startsWith('https://api.github.com/'))return new Response(JSON.stringify(String(url).includes('/actions/runs/')?{id:123,head_sha:process.env.RELEASE_SHA,head_branch:'main',event:'push',status:'completed',conclusion:'success',path:'.github/workflows/ci.yml',repository:{full_name:'Pyratzlabs/paseo-rooms'},head_repository:{full_name:'Pyratzlabs/paseo-rooms'}}:{object:{sha:process.env.RELEASE_SHA}}));
 if(process.env.FAULT==='health')throw Error('TLS failed');
 return new Response(JSON.stringify(String(url).includes('/assets/')?{sha:process.env.RELEASE_SHA,deploymentId:'500'}:{registration:'open'}));
};
global.WebSocket=class{addEventListener(type,handler){if(type==='open')queueMicrotask(handler);}close(){}};
`;

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "deployment-cli-"));
  const artifact = path.join(directory, "release-artifact");
  for (const part of ["deploy", "src/relay", "public"])
    mkdirSync(path.join(artifact, part), { recursive: true });
  writeFileSync(
    path.join(artifact, "release.json"),
    JSON.stringify({ sha, runId: "123" }),
  );
  const imported = path.join(directory, "preload.mjs");
  writeFileSync(imported, preload);
  const calls = path.join(directory, "calls");
  const env = {
    ...process.env,
    RELEASE_SHA: sha,
    RELEASE_RUN_ID: "123",
    DEPLOY_DRY_RUN: "false",
    CI_JOB_ID: "500",
    ROOMS_DOMAIN: "rooms.example.com",
    RELAY_AUTH_MODE: "open",
    DEPLOY_SSH_TARGET: "deployer@192.168.193.100",
    DEPLOY_SSH_PRIVATE_KEY: "dummy-key\n",
    DEPLOY_SSH_KNOWN_HOSTS: "host ssh-ed25519 dummy-public-key",
    CALLS: calls,
  };
  return {
    directory,
    artifact,
    env,
    run: (fault = "", recover = false) =>
      spawnSync(
        process.execPath,
        ["--import", imported, entry, ...(recover ? ["--recover"] : [])],
        {
          cwd: directory,
          env: { ...env, FAULT: fault },
          encoding: "utf8",
          timeout: 10000,
        },
      ),
    actions: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("credentialed coordinator snapshots, stages, activates, verifies, then commits", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.actions(), [
      "secret-materialized",
      "prepare",
      "sync",
      "sync",
      "sync",
      "activate",
      "commit",
    ]);
    assert.equal(
      existsSync(path.join(f.directory, ".relay-deploy-attempted")),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("coordinator recovers preparation, upload, activation and public health failures", () => {
  for (const fault of ["prepare", "sync", "activate", "health"]) {
    const f = fixture();
    try {
      const result = f.run(fault);
      assert.notEqual(result.status, 0);
      assert.deepEqual(f.actions().slice(-2), ["abort", "rollback"]);
      assert.ok(!f.actions().includes("commit"));
      assert.equal(
        existsSync(path.join(f.directory, ".relay-deploy-attempted")),
        false,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("failed recovery preserves its checkpoint for after_script and SIGTERM recovery", () => {
  for (const fault of ["rollback", "cancel"]) {
    const f = fixture();
    try {
      const result = f.run(fault);
      assert.ok(result.status !== 0 || result.signal);
      assert.equal(
        existsSync(path.join(f.directory, ".relay-deploy-attempted")),
        true,
      );
      rmSync(f.artifact, { recursive: true }); // Recovery must not depend on a build/artifact.
      const recovered = f.run("", true);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(f.actions().slice(-2), ["abort", "rollback"]);
      assert.equal(
        existsSync(path.join(f.directory, ".relay-deploy-attempted")),
        false,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("aliased artifacts are rejected before any credential materialization or SSH", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.artifact, "public"), { recursive: true });
    symlinkSync(f.directory, path.join(f.artifact, "public"));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.actions(), []);
  } finally {
    f.cleanup();
  }
});

test("a dry-run does not access SSH credentials or touch the VM", () => {
  const f = fixture();
  try {
    f.env.DEPLOY_DRY_RUN = "true";
    delete f.env.DEPLOY_SSH_PRIVATE_KEY;
    delete f.env.DEPLOY_SSH_KNOWN_HOSTS;
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.actions(), []);
    assert.match(result.stdout, /no VM changes/);
  } finally {
    f.cleanup();
  }
});
