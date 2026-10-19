"""Public template closure and pre-effect source identity; synthetic inputs only."""
import json
from pathlib import Path
import types
import unittest
from unittest import mock

import quarantine as q
import deploy_dev
import launch_deploy as launcher
import private_repository


class CanonicalRecordTests(unittest.TestCase):
    def test_shipped_templates_use_fixed_record_and_reject_release_relative_path(self):
        root = Path(__file__).resolve().parent.parent
        private = Path('/etc/capture402-dev')
        envs = {}
        for role in ('facilitator', 'restaurant'):
            raw = (root/'integration/deploy/dev'/f'{role}.env.example').read_text()
            lines = []
            for line in raw.splitlines():
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    if not v: v = 'synthetic-value'
                    line = k+'='+v
                lines.append(line)
            envs[role] = '\n'.join(lines).encode()
        def read(path, **kwargs):
            if path.name in ('facilitator.env', 'restaurant.env'):
                return envs[path.stem], {'mode': 0o600}
            self.assertIn(path.name, ('sponsor.json', 'merchant.json'))
            return b'synthetic-key-not-used', {'mode': 0o600, 'uid': 12345}
        with (mock.patch.object(q, 'PRIVATE', private), mock.patch.object(q, 'read', side_effect=read),
              mock.patch.object(q.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=12345)),
              mock.patch.object(deploy_dev, 'state_paths', return_value=q.STORE_PATHS)):
            self.assertRegex(q.configuration(), r'^[a-f0-9]{64}$')
            envs['facilitator'] = envs['facilitator'].replace(b'=/etc/capture402/deployment-identity.v1.json', b'=/opt/capture402-dev/current/etc/capture402/deployment-identity.v1.json')
            with self.assertRaisesRegex(RuntimeError, 'QUARANTINE_REFUSED'):
                q.configuration()


class LauncherIdentityTests(unittest.TestCase):
    def test_wrong_numeric_identity_stops_before_recovery_fetch_or_install(self):
        with (mock.patch.object(launcher.sys, 'argv', ['deploy.sh']),
              mock.patch.object(launcher.source, 'require_private_namespace'),
              mock.patch.object(private_repository, 'local_identity'),
              mock.patch.object(private_repository, 'github_identity', side_effect=RuntimeError('identity mismatch')),
              mock.patch.object(launcher.source, 'run', return_value='') as run,
              mock.patch.object(launcher, 'recover_first') as recover,
              mock.patch.object(launcher.subprocess, 'run') as install):
            with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
                launcher.main()
            recover.assert_not_called(); install.assert_not_called()
            self.assertEqual([c.args for c in run.call_args_list], [('git', 'status', '--porcelain')])

    def test_identity_precedes_recovery_and_fetch_refuses_redirects(self):
        effects = []
        def run(*args, **kwargs):
            effects.append(args)
            return 'a'*40 if args[:2] == ('git', 'rev-parse') else ''
        with (mock.patch.object(launcher.sys, 'argv', ['deploy.sh']),
              mock.patch.object(launcher.source, 'require_private_namespace'),
              mock.patch.object(private_repository, 'local_identity'),
              mock.patch.object(private_repository, 'github_identity', side_effect=lambda env: effects.append('identity')),
              mock.patch.object(launcher.source, 'run', side_effect=run),
              mock.patch.object(launcher, 'recover_first', side_effect=lambda: effects.append('recovery')),
              mock.patch.object(launcher, 'require_acceptance', side_effect=RuntimeError('checked gates'))):
            with self.assertRaisesRegex(RuntimeError, 'checked gates'):
                launcher.main()
        fetch = ('git', '-c', 'http.followRedirects=false', 'fetch', 'origin', 'main')
        self.assertLess(effects.index('identity'), effects.index('recovery'))
        self.assertLess(effects.index('recovery'), effects.index(fetch))
