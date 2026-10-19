"""Real local file and race probes for the external installation trust boundary."""
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock
import deployment_config as config
import deploy_demo as source


def root_metadata(value, **changes):
    fields = {name: getattr(value, name) for name in dir(value) if name.startswith('st_')}
    return types.SimpleNamespace(**(fields | {'st_uid': 0} | changes))


class InstallationPolicyTests(unittest.TestCase):
    def test_missing_policy_denies_without_network(self):
        with mock.patch.object(config, 'POLICY_PATH', Path('/nonexistent-installation-policy')):
            with self.assertRaisesRegex(RuntimeError, 'unavailable'): config.require_repository()

    def test_actual_file_bytes_and_assigned_identity_are_required(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            path = Path(tmp) / 'policy.json'
            path.write_text(json.dumps({'schema': 1, 'repository': config.REPOSITORY,
                'repositoryId': 123456789, 'repositoryPrivate': False}))
            path.chmod(0o600)
            original_lstat, original_fstat = Path.lstat, os.fstat
            with mock.patch.object(config, 'POLICY_PATH', path), \
                    mock.patch.object(Path, 'lstat', lambda p: root_metadata(original_lstat(p))), \
                    mock.patch.object(os, 'fstat', lambda fd: root_metadata(original_fstat(fd))):
                self.assertEqual(config.require_repository(), 123456789)
                for bad in ('{}', '{"schema":1,"schema":1}',
                            '{"schema":1,"repository":"fixture/other","repositoryId":123,"repositoryPrivate":false}'):
                    path.write_text(bad)
                    with self.assertRaises(RuntimeError): config.require_repository()
                path.write_text('{"schema":1}')
                path.chmod(0o666)
                with self.assertRaises(RuntimeError): config.load()
                path.chmod(0o600)
                hardlink = Path(tmp) / 'hardlink'
                os.link(path, hardlink)
                with self.assertRaises(RuntimeError): config.load()
                hardlink.unlink()
                real = Path(tmp) / 'real.json'; path.rename(real); path.symlink_to(real)
                with self.assertRaises(RuntimeError): config.load()

    def test_metadata_change_while_reading_refuses(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            path = Path(tmp) / 'policy.json'; path.write_text('{"schema":1}'); path.chmod(0o600)
            original_lstat, original_fstat = Path.lstat, os.fstat
            calls = []
            def changed(fd):
                meta = original_fstat(fd); calls.append(fd)
                return root_metadata(meta, st_mtime_ns=meta.st_mtime_ns + (1 if len(calls) > 1 else 0))
            with mock.patch.object(config, 'POLICY_PATH', path), \
                    mock.patch.object(Path, 'lstat', lambda p: root_metadata(original_lstat(p))), \
                    mock.patch.object(os, 'fstat', changed):
                with self.assertRaisesRegex(RuntimeError, 'unavailable'): config.load()

    def test_accepted_record_requires_trusted_exact_bytes(self):
        raw = b'{"synthetic":"record"}'
        with mock.patch.object(config, 'read_record', return_value=raw), \
                mock.patch.object(config, 'digest', return_value=hashlib.sha256(raw).hexdigest()):
            self.assertEqual(source.deployment_record(), {'synthetic': 'record'})
        with mock.patch.object(config, 'read_record', return_value=raw + b' '), \
                mock.patch.object(config, 'digest', return_value=hashlib.sha256(raw).hexdigest()):
            with self.assertRaisesRegex(RuntimeError, 'differs'): source.deployment_record()
