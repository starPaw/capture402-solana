"""SOURCE-IDENTITY regression checks use private fixtures and never contact GitHub."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import private_repository as guard

ROOT = Path(__file__).resolve().parents[1]


def args(command='check', **overrides):
    return argparse.Namespace(command=command, github=False, route='issues/123/comments',
                              method='POST', input='comment.json', **overrides)


class GuardTests(unittest.TestCase):
    def test_effective_origin_urls_including_rewrites_and_multiple_push_targets(self):
        # Real Git configuration and get-url expansion; no fetch/push/network.
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
            def git(*command):
                subprocess.run(['git', '-C', tmp, *command], env=env, check=True)
            def read(*command, **kwargs):
                return subprocess.check_output([command[0], '-C', tmp, *command[1:]],
                                               env=env, text=True).strip()
            git('remote', 'add', 'origin', next(iter(guard.SOURCE_URLS)))
            with mock.patch.object(guard, 'output', side_effect=read):
                guard.local_identity()
                git('config', 'remote.origin.pushurl', 'https://github.com/fixture/frozen.git')
                with self.assertRaises(RuntimeError): guard.local_identity()
                git('config', '--unset-all', 'remote.origin.pushurl')
                git('config', 'url.https://github.com/fixture/frozen.git.insteadOf',
                    next(iter(guard.SOURCE_URLS)))
                with self.assertRaises(RuntimeError): guard.local_identity()
                git('config', '--remove-section', 'url.https://github.com/fixture/frozen.git')
                git('config', '--add', 'remote.origin.pushurl', next(iter(guard.SOURCE_URLS)))
                git('config', '--add', 'remote.origin.pushurl', next(iter(guard.SOURCE_URLS)))
                with self.assertRaises(RuntimeError): guard.local_identity()

    def test_rejected_local_identity_makes_no_github_or_effect_call(self):
        for command in ('check', 'fetch', 'api'):
            with self.subTest(command=command), mock.patch.object(guard, 'output', return_value='https://github.com/fixture/frozen.git') as read, mock.patch.object(guard.subprocess, 'call') as effect:
                with self.assertRaises(RuntimeError): guard.operation(args(command))
                self.assertTrue(all(call.args[0] == 'git' for call in read.call_args_list))
                effect.assert_not_called()

    def test_numeric_metadata_and_strict_name_id_visibility(self):
        valid = dict(id=123456789, full_name=guard.REPOSITORY, private=False)
        for item in (valid, dict(valid, id=987654321), dict(valid, private=True),
                     dict(valid, id=str(123456789)), dict(valid, full_name='fixture/renamed'),
                     {}, [], None):
            with self.subTest(item=item), mock.patch.object(guard, 'output', return_value=json.dumps(item)) as read:
                if item == valid:
                    guard.github_identity({})
                else:
                    with self.assertRaises(RuntimeError): guard.github_identity({})
                self.assertEqual(read.call_args.args, ('gh', 'api', '--hostname', 'github.com',
                                                       'repositories/123456789'))
        with mock.patch.object(guard, 'output', return_value='invalid'):
            with self.assertRaises(RuntimeError): guard.github_identity({})

    def test_failed_metadata_prevents_effects(self):
        with mock.patch.object(guard, 'local_identity'), mock.patch.object(guard, 'github_identity', side_effect=RuntimeError('denied')), mock.patch.object(guard.subprocess, 'call') as effect:
            with self.assertRaises(RuntimeError): guard.operation(args('api'))
            effect.assert_not_called()

    def test_route_escapes_and_merge_rejected_before_network(self):
        for route in ('https://github.com/fixture/frozen', 'repos/fixture/frozen/issues',
                      '/issues', 'issues/../pulls', 'issues%2f123', 'issues?repo=other',
                      'issues/123\n', 'pulls/123/merge'):
            with self.subTest(route=route), mock.patch.object(guard, 'output') as read, mock.patch.object(guard.subprocess, 'call') as effect:
                value = args('api'); value.route = route
                with self.assertRaises(RuntimeError): guard.operation(value)
                read.assert_not_called(); effect.assert_not_called()

    def test_valid_api_fixes_destination_and_host_after_identity(self):
        events = []
        with mock.patch.object(guard, 'local_identity', side_effect=lambda: events.append('local')), mock.patch.object(guard, 'github_identity', side_effect=lambda env: events.append('github')), mock.patch.object(guard.subprocess, 'call', side_effect=lambda *a, **k: events.append('effect') or 0) as effect, mock.patch.dict(os.environ, GH_HOST='other.invalid', GH_REPO='fixture/frozen'):
            self.assertEqual(guard.operation(args('api')), 0)
        self.assertEqual(events, ['local', 'github', 'effect'])
        self.assertEqual(effect.call_args.args[0], ['gh', 'api', '--hostname', 'github.com',
                         '--method', 'POST', 'repositories/123456789/issues/123/comments',
                         '--input', 'comment.json'])
        self.assertEqual(effect.call_args.kwargs['env']['GH_HOST'], 'github.com')
        self.assertEqual(effect.call_args.kwargs['env']['GH_REPO'], guard.REPOSITORY)

    def test_fetch_and_push_fix_remote_ref_and_disable_redirects(self):
        with mock.patch.object(guard, 'local_identity'), mock.patch.object(guard, 'github_identity'), mock.patch.object(guard, 'output', return_value='codex/example'), mock.patch.object(guard.subprocess, 'call', return_value=0) as effect:
            guard.operation(args('fetch'))
            self.assertEqual(effect.call_args.args[0], ['git', '-c', 'http.followRedirects=false', 'fetch', 'origin'])
            guard.operation(args('push'))
            self.assertEqual(effect.call_args.args[0], ['git', '-c', 'http.followRedirects=false',
                                                     '-c', 'remote.origin.mirror=false', 'push', '--set-upstream',
                                                     '--no-follow-tags', 'origin', 'HEAD:refs/heads/codex/example'])
        with mock.patch.object(guard, 'output', return_value='main'), mock.patch.object(guard, 'github_identity') as metadata:
            with self.assertRaises(RuntimeError): guard.operation(args('push'))
            metadata.assert_not_called()

    def test_absent_or_mismatched_assigned_repository_id_refuses_before_effects(self):
        import deployment_config
        for value in ({}, {'schema': 1, 'repository': guard.REPOSITORY, 'repositoryId': 0, 'repositoryPrivate': False},
                      {'schema': 1, 'repository': 'fixture/other', 'repositoryId': 123, 'repositoryPrivate': False},
                      {'schema': 1, 'repository': guard.REPOSITORY, 'repositoryId': 123, 'repositoryPrivate': True}):
            with mock.patch.object(deployment_config, 'load', return_value=value), mock.patch.object(guard, 'output') as read, mock.patch.object(guard.subprocess, 'call') as effect:
                with self.assertRaises(RuntimeError): guard.operation(args('fetch'))
                read.assert_not_called(); effect.assert_not_called()



def setUpModule():
    global _installation_fixture
    from operator_test_fixture import install
    _installation_fixture = install()


def tearDownModule():
    _installation_fixture.stop()
