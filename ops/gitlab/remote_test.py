import importlib.util
import json
from pathlib import Path
import tempfile
import shutil
import unittest

spec = importlib.util.spec_from_file_location('remote', Path(__file__).with_name('remote.py'))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
OLD = 'sha256:' + 'a' * 64
NEW = 'sha256:' + 'b' * 64
SHA = 'c' * 40


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='rooms-transaction-')
        self.root = Path(self.temporary.name)
        self.directory = self.root / 'apps/relay-web/deploy'
        self.directory.mkdir(parents=True)
        (self.directory / '.env').write_text('RELAY_AUTH_MODE=open\nKEEP_PRIVATE=original-secret\n')
        (self.directory / 'compose.proxy.yml').write_text('original-compose')
        self.image = OLD
        self.fail_build = False
        self.abort_build = False
        self.abort_identity = False
        self.calls = []
        self.original_run = remote.run
        self.original_verify = remote.verify_current_main
        self.stale = False
        remote.verify_current_main = self.fake_verify
        remote.run = self.fake_run

    def tearDown(self):
        remote.run = self.original_run
        remote.verify_current_main = self.original_verify
        self.temporary.cleanup()

    def fake_verify(self, sha):
        if self.stale:
            raise RuntimeError('Release was superseded before activation')

    def fake_run(self, args, directory, capture=False, timeout=60):
        self.calls.append(args)
        if args[0] == 'rsync':
            source, destination = Path(args[-2]), Path(args[-1])
            for item in source.rglob('*'):
                if item.is_file():
                    target = destination / item.relative_to(source)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(item, target)
            return ''
        if args[:3] == ['docker', 'inspect', '--format']:
            return '172.18.0.3\n' if args[-1] == 'nginx-proxy' else (self.image or '') + '\n'
        if args[:3] == ['docker', 'image', 'inspect']:
            return NEW + '\n'
        if 'ps' in args:
            return 'container-id\n' if self.image else ''
        if '--images' in args:
            if self.abort_identity:
                (self.directory / '.deploy-history/500/abort').write_text('cancelled')
            return 'deploy-relay\n'
        if 'build' in args:
            self.assertEqual(timeout, 600)
            if self.abort_build:
                (self.directory / '.deploy-history/500/abort').write_text('cancelled')
            if self.fail_build:
                raise RuntimeError('simulated build failure')
        if 'up' in args:
            override = self.directory / ('.rollback-image.yml' if any('rollback-image' in x for x in args) else '.active-release.yml')
            self.image = json.loads(override.read_text())['services']['relay']['image']
        if args[:2] == ['docker', 'stop']:
            self.image = None
        return ''

    def action(self, action, owner='500'):
        environment = {'ROOMS_DOMAIN': 'rooms.example.com', 'ROOMS_HOSTNAMES': 'rooms.example.com,old.example.com', 'RELAY_AUTH_MODE': 'open', 'RELAY_TRUSTED_PROXY_ADDRESSES': '172.18.0.3', 'RELAY_MAX_HOSTS': '256', 'RELAY_MAX_HOSTS_PER_SOURCE': '32'}
        result = remote.execute({'action': action, 'directory': str(self.root), 'deploymentId': owner, 'sha': SHA, 'environment': environment})
        if action == 'prepare':
            stage = self.root / '.relay-staging' / owner / 'apps/relay-web/deploy/compose.proxy.yml'
            stage.write_text('new-compose-from-staged-upload')
        return result

    def state(self):
        return json.loads((self.directory / '.deploy-transaction.json').read_text())

    def test_checkpoint_precedes_sync_and_external_failure_restores_matching_release(self):
        self.action('prepare')
        self.assertEqual((self.directory / 'compose.proxy.yml').read_text(), 'original-compose')
        self.action('activate')
        self.assertEqual((self.directory / 'compose.proxy.yml').read_text(), 'new-compose-from-staged-upload')
        self.assertEqual(self.image, NEW)
        self.assertEqual((self.directory / '.deploy-history/500/compose.proxy.yml').read_text(), 'original-compose')
        self.assertIn('KEEP_PRIVATE=original-secret', (self.directory / '.env').read_text())
        self.action('abort')
        self.action('rollback')  # Same recovery used for public HTTPS/WSS and SSH-response failures.
        self.assertEqual(self.image, OLD)
        self.assertEqual((self.directory / 'compose.proxy.yml').read_text(), 'original-compose')
        self.assertEqual(self.state()['phase'], 'rolled_back')
        with self.assertRaises(RuntimeError):
            self.action('commit')

    def test_build_failure_keeps_active_env_and_image(self):
        self.action('prepare')
        before = (self.directory / '.env').read_text()
        self.fail_build = True
        with self.assertRaises(RuntimeError):
            self.action('activate')
        self.assertEqual(self.image, OLD)
        self.assertEqual((self.directory / '.env').read_text(), before)
        self.action('rollback')
        self.assertEqual(self.image, OLD)
        self.assertFalse(any('up' in call for call in self.calls), 'a prepared-only failure must not restart the healthy relay')

    def test_cancelled_build_cannot_activate_after_recovery_was_requested(self):
        self.action('prepare')
        self.abort_build = True
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            self.action('activate')
        self.assertEqual(self.image, OLD)
        self.assertFalse(any('up' in call for call in self.calls))
        self.action('rollback')
        self.assertEqual(self.state()['phase'], 'rolled_back')

    def test_late_recovery_never_undoes_committed_or_different_release(self):
        self.action('prepare')
        self.action('activate')
        self.action('commit')
        self.action('rollback')
        self.action('rollback', owner='999')
        self.assertEqual(self.image, NEW)
        self.assertEqual(self.state()['phase'], 'committed')
        self.action('prepare', owner='501')
        self.assertEqual(self.state()['owner'], '501')
        self.action('rollback', owner='500')
        self.assertEqual(self.state()['owner'], '501')

    def test_cancellation_during_identity_checks_cannot_activate(self):
        self.action('prepare')
        before = (self.directory / '.env').read_text()
        self.abort_identity = True
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            self.action('activate')
        self.assertEqual(self.state()['phase'], 'prepared')
        self.assertEqual((self.directory / '.env').read_text(), before)
        self.assertFalse(any('up' in call for call in self.calls))
        self.action('rollback')

    def test_interrupted_transaction_must_be_recovered_before_another_starts(self):
        self.action('prepare')
        with self.assertRaisesRegex(RuntimeError, 'recovered'):
            self.action('prepare', owner='501')
        self.action('rollback')
        self.action('prepare', owner='501')
        self.assertEqual(self.state()['phase'], 'prepared')

    def test_first_deployment_failure_stops_only_the_new_relay(self):
        self.image = None
        (self.directory / '.env').unlink()
        (self.directory / 'compose.proxy.yml').unlink()
        self.action('prepare')
        (self.directory / 'compose.proxy.yml').write_text('new-compose')
        self.action('activate')
        self.assertEqual(self.image, NEW)
        self.action('rollback')
        self.assertIsNone(self.image)
        self.assertFalse((self.directory / '.env').exists())
        self.assertEqual(self.state()['phase'], 'rolled_back')

    def test_running_image_must_match_the_expected_release_before_commit(self):
        self.action('prepare')
        self.action('activate')
        self.image = OLD
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            self.action('commit')

    def test_late_staging_upload_cannot_overwrite_a_restored_release(self):
        self.action('prepare')
        self.action('abort')
        self.action('rollback')
        stage = self.root / '.relay-staging/500/apps/relay-web/deploy/compose.proxy.yml'
        stage.write_text('late-orphaned-upload')
        self.assertEqual((self.directory / 'compose.proxy.yml').read_text(), 'original-compose')
        self.assertEqual(self.image, OLD)
        with self.assertRaises(RuntimeError):
            self.action('activate')

    def test_main_advancing_during_build_cannot_activate_a_stale_release(self):
        self.action('prepare')
        self.stale = True
        with self.assertRaisesRegex(RuntimeError, 'superseded'):
            self.action('activate')
        self.action('rollback')
        self.assertEqual(self.image, OLD)
        self.assertFalse(any('up' in call for call in self.calls))

    def test_env_updates_and_checkpoint_paths_reject_injection(self):
        self.action('prepare')
        with self.assertRaises(ValueError):
            remote.execute({'action': 'activate', 'directory': str(self.root), 'deploymentId': '500', 'sha': SHA, 'environment': {'ROOMS_DOMAIN': 'rooms.example\nEVIL=1'}})
        with self.assertRaises(ValueError):
            self.action('rollback', owner='../500')


if __name__ == '__main__':
    unittest.main()
