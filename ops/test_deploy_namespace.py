"""Offline namespace gates: fixture files only, no launcher/host commands or network."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import deploy_demo as source
import deploy_dev as dev
import deploy_vps as host
import host_cli as cli
import launch_deploy as launcher
import release_policy as policy

SHA = 'a' * 40
LEGACY = 'fixture/' + 'wrong-source'


class NamespaceEntryTests(unittest.TestCase):
    def test_mismatched_source_or_policy_denies_entry_before_any_effect(self):
        entries = [lambda: cli.main(['deploy', SHA]), lambda: cli.main(['recover']),
                   lambda: cli.main(['dev', 'deploy', SHA]), cli.recover_first,
                   launcher.main, launcher.recover_first,
                   lambda: host.main([SHA]), lambda: host.main(['--recover']),
                   lambda: host.main(['--gate']), lambda: host.deploy(SHA),
                   lambda: dev.dispatch(['deploy', SHA]), lambda: dev.main(['recover']),
                   lambda: dev.deploy(SHA, mock.Mock()), dev.recover, source.recover_pending]
        for module, name, value in [(source, 'SOURCE_REMOTE', 'ssh://git@github.com/' + LEGACY + '.git'),
                                     (policy, 'REPOSITORY', LEGACY)]:
            for entry in entries:
                with self.subTest(constant=name, entry=entry), contextlib.ExitStack() as stack:
                    stack.enter_context(mock.patch.object(module, name, value))
                    stack.enter_context(mock.patch.object(source.os, 'geteuid', return_value=0))
                    stack.enter_context(mock.patch.object(launcher.sys, 'argv', ['deploy.sh', '--install-cli']))
                    run = stack.enter_context(mock.patch.object(source, 'run'))
                    process = stack.enter_context(mock.patch.object(source.subprocess, 'run'))
                    api = stack.enter_context(mock.patch.object(cli, 'GitHub'))
                    allocate = stack.enter_context(mock.patch.object(dev.Attempt, 'create'))
                    identity = stack.enter_context(mock.patch.object(launcher.private_repository, 'local_identity'))
                    mkdir = stack.enter_context(mock.patch.object(Path, 'mkdir'))
                    with self.assertRaisesRegex(RuntimeError, '^SOURCE-IDENTITY: controller namespace mismatch'):
                        entry()
                    for effect in (run, process, api, allocate, identity, mkdir): effect.assert_not_called()

    def test_launcher_rejects_effective_origin_before_ssh_or_recovery(self):
        with (mock.patch.object(launcher.sys, 'argv', ['deploy.sh']),
              mock.patch.object(launcher.private_repository, 'local_identity', side_effect=RuntimeError('origin denied')),
              mock.patch.object(source, 'run') as run,
              mock.patch.object(launcher, 'recover_first') as recover,
              mock.patch.object(launcher.subprocess, 'run') as remote):
            with self.assertRaisesRegex(RuntimeError, 'origin denied'): launcher.main()
        run.assert_not_called(); recover.assert_not_called(); remote.assert_not_called()

    def test_no_pending_requires_no_recovery_target_or_network(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(source, 'BASE', Path(tmp)), \
                mock.patch.object(source, 'require_private_recovery_namespace') as target, \
                mock.patch.object(source, 'run') as run:
            self.assertFalse(cli.recover_first())
        target.assert_not_called(); run.assert_not_called()

    def test_host_checks_recovery_target_before_starting_unit(self):
        with tempfile.TemporaryDirectory() as tmp:
            pending = Path(tmp) / 'transaction.json'
            original = b'{"previous":"original","economicOutcome":"UNKNOWN"}'
            pending.write_bytes(original)
            with (mock.patch.object(source, 'BASE', Path(tmp)),
                  mock.patch.object(source, 'require_private_recovery_namespace', side_effect=RuntimeError('target denied')),
                  mock.patch.object(source, 'run') as run):
                with self.assertRaisesRegex(RuntimeError, 'target denied'): cli.recover_first()
            run.assert_not_called(); self.assertEqual(pending.read_bytes(), original)


class InstalledRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.unit = self.root / 'etc/systemd/system/capture402-recovery.service'
        self.directory = self.root / ('opt/capture402/controllers/' + SHA)
        self.unit.parent.mkdir(parents=True); self.directory.mkdir(parents=True)
        self.unit.write_text('[Service]\nExecStart=/usr/bin/python3 -B /opt/capture402/controllers/' + SHA + '/deploy_vps.py --recover\n')
        (self.directory / 'deploy_vps.py').write_text('raise RuntimeError("must never execute installed code")\n')
        self.source = self.directory / 'deploy_demo.py'
        self.policy = self.directory / 'release_policy.py'
        self.source.write_text('SOURCE_REMOTE = "ssh://git@github.com/starPaw/capture402-solana.git"\nraise RuntimeError("must never execute installed code")\n')
        self.policy.write_text('REPOSITORY = "starPaw/capture402-solana"\n')
        self.pending = self.root / 'opt/capture402/transaction.json'
        self.pending.write_bytes(b'original pending bytes')
        def mapped_path(path):
            p = str(path)
            return self.root / p.lstrip('/') if p.startswith(('/etc/', '/opt/')) else Path(path)
        self.stack.enter_context(mock.patch('pathlib.Path', side_effect=mapped_path))
        self.metadata = self.stack.enter_context(mock.patch.object(source.subprocess, 'check_output',
            return_value=f'FragmentPath={self.unit}\nDropInPaths=\nNeedDaemonReload=no\n'))
        self.effect = self.stack.enter_context(mock.patch.object(source.subprocess, 'run'))

    def test_valid_private_declarations_are_inspected_without_import(self):
        source.require_private_recovery_namespace()
        self.effect.assert_not_called()
        self.assertEqual(self.metadata.call_args.args[0][:2], ['systemctl', 'show'])

    def test_legacy_missing_duplicate_dynamic_or_malformed_declarations_refuse(self):
        fixtures = [(self.source, 'SOURCE_REMOTE = "ssh://git@github.com/' + LEGACY + '.git"\n'),
                    (self.policy, 'REPOSITORY = "' + LEGACY + '"\n'),
                    (self.policy, ''), (self.policy, 'REPOSITORY = get_namespace()\n'),
                    (self.policy, 'REPOSITORY = "starPaw/capture402-solana"\nREPOSITORY = "other/repo"\n'),
                    (self.policy, 'REPOSITORY = "starPaw/capture402-solana"\nREPOSITORY: str = "other/repo"\n'),
                    (self.policy, 'REPOSITORY = "starPaw/capture402-solana"\nif True:\n    REPOSITORY = "other/repo"\n'),
                    (self.policy, 'REPOSITORY = (\n')]
        for path, text in fixtures:
            original = path.read_text()
            with self.subTest(text=text):
                path.write_text(text)
                with self.assertRaisesRegex(RuntimeError, '^SOURCE-IDENTITY: recovery controller namespace unverified'):
                    source.require_private_recovery_namespace()
                self.effect.assert_not_called()
            path.write_text(original)

    def test_effective_unit_drift_or_missing_metadata_refuses(self):
        for fields in [f'FragmentPath={self.unit}\nDropInPaths=override.conf\nNeedDaemonReload=no\n',
                       f'FragmentPath={self.unit}\nDropInPaths=\nNeedDaemonReload=yes\n',
                       'FragmentPath=/other/unit\nDropInPaths=\nNeedDaemonReload=no\n', '']:
            with self.subTest(fields=fields):
                self.metadata.return_value = fields
                with self.assertRaisesRegex(RuntimeError, 'recovery denied'): source.require_private_recovery_namespace()
        self.effect.assert_not_called()

    def test_missing_source_or_symlink_refuses(self):
        original = self.policy.read_bytes()
        self.policy.unlink()
        with self.assertRaisesRegex(RuntimeError, 'recovery denied'): source.require_private_recovery_namespace()
        target = self.directory / 'policy-copy.py'
        target.write_bytes(original)
        self.policy.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'recovery denied'): source.require_private_recovery_namespace()
        self.effect.assert_not_called()

    def test_unavailable_unit_metadata_refuses_without_start(self):
        for error in (OSError('unavailable'), source.subprocess.TimeoutExpired('systemctl', 10)):
            with self.subTest(error=type(error).__name__):
                self.metadata.side_effect = error
                with self.assertRaisesRegex(RuntimeError, 'recovery denied'): source.require_private_recovery_namespace()
        self.effect.assert_not_called()

    def test_alternate_exec_target_or_prestart_refuses(self):
        for text in ['[Service]\nExecStart=/bin/true\n',
                     '[Service]\nExecStart=/usr/bin/python3 -B /tmp/deploy_vps.py --recover\n',
                     self.unit.read_text() + 'ExecStartPre=/bin/true\n']:
            self.unit.write_text(text)
            with self.assertRaisesRegex(RuntimeError, 'recovery denied'): source.require_private_recovery_namespace()
        self.effect.assert_not_called()

    def test_launcher_remote_preflight_preserves_pending_on_old_namespace(self):
        self.policy.write_text('REPOSITORY = "' + LEGACY + '"\n')
        with self.assertRaisesRegex(RuntimeError, 'recovery denied'):
            exec(launcher.RECOVER.replace('p = load()', "p = {'schema':1,'repository':'starPaw/capture402-solana','repositoryId':123456789,'repositoryPrivate':False}"), {})
        self.effect.assert_not_called()
        self.assertEqual(self.pending.read_bytes(), b'original pending bytes')

    def test_launcher_valid_private_recovery_keeps_explicit_reinvoke_boundary(self):
        self.effect.side_effect = lambda *a, **k: self.pending.unlink()
        out = io.StringIO()
        with contextlib.redirect_stdout(out): exec(launcher.RECOVER.replace('p = load()', "p = {'schema':1,'repository':'starPaw/capture402-solana','repositoryId':123456789,'repositoryPrivate':False}"), {})
        self.assertEqual(out.getvalue(), 'RECOVERED\n')
        self.effect.assert_called_once_with(['systemctl', 'start', 'capture402-recovery.service'], check=True)


if __name__ == '__main__': unittest.main()


def setUpModule():
    global _installation_fixture
    from operator_test_fixture import install
    _installation_fixture = install()
    global _record_fixture
    from unittest import mock
    import deploy_demo
    _record_fixture = mock.patch.object(deploy_demo, "RECORD", "fixtures/deployment-identity.v1.json")
    _record_fixture.start()


def tearDownModule():
    _record_fixture.stop()
    _installation_fixture.stop()
