"""Trusted relay operations with a VM-side lock and release-owned checkpoints."""
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request


def run(args, directory, capture=False, timeout=60):
    return subprocess.run(args, cwd=directory, check=True, text=True, timeout=timeout,
                          stdout=subprocess.PIPE if capture else None).stdout


def atomic_text(target, text):
    fd, temporary = tempfile.mkstemp(prefix='.deploy-', dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as file:
            file.write(text)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def merge_env(source, target, updates):
    remaining = dict(updates)
    output = []
    for line in source.read_text().splitlines() if source.exists() else []:
        key = line.partition('=')[0]
        if key in updates:
            if key in remaining:
                output.append(key + '=' + remaining.pop(key))
        else:
            output.append(line)
    output.extend(key + '=' + value for key, value in remaining.items())
    atomic_text(target, '\n'.join(output) + '\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_current_main(sha):
    url = 'https://api.github.com/repos/Pyratzlabs/paseo-rooms/git/ref/heads/main'
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'paseo-rooms-deployment'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
        if response.geturl() != url or json.load(response).get('object', {}).get('sha') != sha:
            raise RuntimeError('Release was superseded before activation')


def execute(request):
    root, owner = request['directory'], request['deploymentId']
    if not isinstance(root, str) or not re.fullmatch(r'(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+', root):
        raise ValueError('Invalid deployment directory')
    if not re.fullmatch(r'[1-9][0-9]{0,14}', str(owner)):
        raise ValueError('Invalid deployment identity')
    directory = Path(root) / 'apps/relay-web/deploy'
    directory.mkdir(parents=True, exist_ok=True)
    history = directory / '.deploy-history' / str(owner)
    action = request['action']
    staging = Path(root) / '.relay-staging' / str(owner)
    # Cancellation can mark a build while that build holds the host lock.
    if action == 'abort':
        if history.is_dir():
            atomic_text(history / 'abort', 'cancelled\n')
        return
    with (directory / '.deploy.lock').open('a') as lock:
        deadline = time.monotonic() + 650
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Deployment lock remained busy')
                time.sleep(1)
        state_file = directory / '.deploy-transaction.json'
        state = json.loads(state_file.read_text()) if state_file.exists() else None
        base = ['docker', 'compose', '--env-file', '.env', '-f', 'compose.proxy.yml']
        active = base + ['-f', '.active-release.yml']

        def store(value):
            atomic_text(state_file, json.dumps(value))

        def current_image(command):
            container = run(command + ['ps', '-q', 'relay'], directory, capture=True).strip()
            return run(['docker', 'inspect', '--format', '{{.Image}}', container], directory, capture=True).strip() if container else None

        def check_abort():
            if (history / 'abort').exists():
                raise RuntimeError('Deployment was cancelled')

        if action == 'prepare':
            if state and state['phase'] not in ['committed', 'rolled_back']:
                raise RuntimeError('An interrupted deployment must be recovered first')
            if history.exists():
                raise RuntimeError('Deployment identity already used')
            history.mkdir(parents=True, mode=0o700)
            os.chmod(history.parent, 0o700)
            previous = None
            if (directory / 'compose.proxy.yml').exists() and (directory / '.env').exists():
                previous = current_image(active if (directory / '.active-release.yml').exists() else base)
            if previous and not re.fullmatch(r'sha256:[a-f0-9]{64}', previous):
                raise ValueError('Invalid previous image identity')
            for name in ['.env', 'compose.proxy.yml', '.active-release.yml']:
                if (directory / name).exists():
                    shutil.copy2(directory / name, history / name)
                    os.chmod(history / name, 0o600)
            store({'owner': owner, 'phase': 'prepared', 'previousImage': previous})
            proxy = run(['docker', 'inspect', '--format', '{{with index .NetworkSettings.Networks "web"}}{{.IPAddress}}{{end}}', 'nginx-proxy'], directory, capture=True).strip()
            ipaddress.ip_address(proxy)
            for relative in ['apps/relay-web/deploy', 'apps/relay-web/src/relay', 'apps/relay-web/public']:
                (staging / relative).mkdir(parents=True, exist_ok=True)
            print(json.dumps({'proxy': proxy}))
            return
        if not state or state['owner'] != owner:
            if action == 'rollback':
                return  # Never roll back an unrelated transaction.
            raise RuntimeError('Checkpoint belongs to a different deployment')
        if action == 'activate':
            if state['phase'] != 'prepared':
                raise RuntimeError('Invalid deployment phase')
            check_abort()
            # Uploads target only owner-specific staging. Promotion shares this
            # host lock with activation and recovery, so a late rsync cannot
            # overwrite a restored active compose/environment.
            for relative in ['deploy', 'src/relay', 'public']:
                destination = Path(root) / 'apps/relay-web' / relative
                destination.mkdir(parents=True, exist_ok=True)
                run(['rsync', '-az', '--delete', '--exclude=.env*', '--exclude=.deploy*', '--exclude=.active-release.yml', '--exclude=.rollback-image.yml', str(staging / 'apps/relay-web' / relative) + '/', str(destination) + '/'], directory)
            check_abort()
            updates = request['environment']
            allowed = {'ROOMS_DOMAIN', 'ROOMS_HOSTNAMES', 'RELAY_AUTH_MODE', 'RELAY_KEY', 'RELAY_TRUSTED_PROXY_ADDRESSES', 'RELAY_MAX_HOSTS', 'RELAY_MAX_HOSTS_PER_SOURCE'}
            if not isinstance(updates, dict) or set(updates) - allowed:
                raise ValueError('Unexpected environment update')
            if any(not isinstance(value, str) or '\n' in value or '\r' in value for value in updates.values()):
                raise ValueError('Invalid environment value')
            sha = request['sha']
            if not re.fullmatch(r'[a-f0-9]{40}', sha):
                raise ValueError('Invalid release SHA')
            candidate = directory / '.env.next'
            try:
                merge_env(directory / '.env', candidate, updates)
                staged = ['docker', 'compose', '--env-file', '.env.next', '-f', 'compose.proxy.yml']
                run(staged + ['config', '--quiet'], directory)
                run(staged + ['build', 'relay'], directory, timeout=600)
                check_abort()
                verify_current_main(sha)
                images = run(staged + ['config', '--images'], directory, capture=True).strip().splitlines()
                if len(images) != 1:
                    raise ValueError('Expected one relay image')
                image = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', images[0]], directory, capture=True).strip()
                if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
                    raise ValueError('Invalid built image identity')
                check_abort()
                state.update({'phase': 'activated', 'expectedImage': image, 'sha': sha})
                store(state)  # Durable recovery record before switching the running service.
                override = {'services': {'relay': {'image': image, 'labels': {'io.pyratz.rooms.revision': sha, 'io.pyratz.rooms.deployment': str(owner)}}}}
                atomic_text(directory / '.active-release.yml', json.dumps(override))
                os.replace(candidate, directory / '.env')
                run(active + ['up', '-d', '--no-build', '--no-deps', 'relay'], directory)
                if current_image(active) != image:
                    raise RuntimeError('Running image does not match the built release')
                return
            finally:
                candidate.unlink(missing_ok=True)
        if action == 'commit':
            check_abort()
            if state['phase'] != 'activated' or current_image(active) != state['expectedImage']:
                raise RuntimeError('Active release identity changed')
            state['phase'] = 'committed'
            store(state)
            return
        if action == 'rollback':
            if state['phase'] in ['committed', 'rolled_back']:
                return  # A late cancellation must never undo an already committed release.
            for name in ['.env', 'compose.proxy.yml', '.active-release.yml']:
                if (history / name).exists():
                    shutil.copy2(history / name, directory / name)
                else:
                    (directory / name).unlink(missing_ok=True)
            if state['previousImage'] and not (state['phase'] == 'prepared' and current_image(active if (directory / '.active-release.yml').exists() else base) == state['previousImage']):
                rollback = directory / '.rollback-image.yml'
                atomic_text(rollback, json.dumps({'services': {'relay': {'image': state['previousImage']}}}))
                restored = active if (directory / '.active-release.yml').exists() else base
                run(restored + ['-f', str(rollback), 'up', '-d', '--no-build', '--no-deps', 'relay'], directory)
                if current_image(restored) != state['previousImage']:
                    raise RuntimeError('Rollback image verification failed')
            elif not state['previousImage']:
                # First deployment has no previous image. Stop only this service.
                container = run(['docker', 'ps', '-aq', '--filter', 'name=^/deploy-relay-1$'], directory, capture=True).strip()
                if container:
                    run(['docker', 'stop', container], directory)
            state['phase'] = 'rolled_back'
            store(state)
            return
        raise ValueError('Unknown deployment action')


if __name__ == '__main__':
    try:
        execute(json.load(sys.stdin))
    except Exception:
        print('Relay VM operation failed; inspect its deployment checkpoint and container locally.', file=sys.stderr)
        sys.exit(1)
