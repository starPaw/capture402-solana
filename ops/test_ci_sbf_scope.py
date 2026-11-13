"""Public CI builds current source; it never imports historical acceptance artifacts."""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[1]

class SourceBuildTests(unittest.TestCase):
    def test_explicit_workflow_test_targets_exist(self):
        text = (ROOT / '.github/workflows/components.yml').read_text()
        for relative in re.findall(r'\btest/[A-Za-z0-9_./-]+\.test\.ts\b', text):
            self.assertTrue((ROOT / 'integration' / relative).is_file(), relative)

    def run_builder(self, cli='solana-cli 4.4.0-rc.1 (fixture)',
                    builder='cargo-build-sbf 4.6.0\nDefault platform-tools: v1.58', compiler=None, v2=False, overrides=()):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            script = root / 'scripts/build-sbf.sh'
            shutil.copyfile(ROOT / 'scripts/build-sbf.sh', script)
            for name, body in {
                'solana': '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_CLI"\n',
                'cargo-build-sbf': '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if sys.argv[1:] == ['--version']:
    print(os.environ['FIXTURE_BUILDER'])
else:
    Path(os.environ['FIXTURE_RECORD']).write_text(json.dumps({
        'args': sys.argv[1:], 'rustc': os.environ.get('RUSTC')}))
''',
            }.items():
                executable = root / 'bin' / name
                executable.write_text(body)
                executable.chmod(0o755)
            env = dict(os.environ, PATH=str(root / 'bin') + os.pathsep + os.environ['PATH'],
                       FIXTURE_CLI=cli, FIXTURE_BUILDER=builder, FIXTURE_RECORD=str(root / 'record'))
            env.pop('RUSTC', None)
            env.pop('CAPTURE402_SBF_RUSTC', None)
            if compiler:
                env['CAPTURE402_SBF_RUSTC'] = compiler
            result = subprocess.run(['bash', str(script), *(['--protocol-v2'] if v2 else []), *overrides, '--offline'], env=env,
                                    capture_output=True, text=True, check=False)
            record = root / 'record'
            return result, json.loads(record.read_text()) if record.exists() else None

    def test_builder_pins_arch_tools_lock_and_output(self):
        result, record = self.run_builder()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(record, {'args': ['--tools-version', 'v1.58', '--arch', 'v3',
                         '--sbf-out-dir', 'target/deploy', '--', '--locked', '--offline'], 'rustc': None})

    def test_wrong_toolchain_refuses_before_build(self):
        for versions in [dict(cli='solana-cli 4.3.2 (fixture)'),
                         dict(cli='solana-cli 4.4.0-rc.10 (fixture)'),
                         dict(builder='cargo-build-sbf 4.4.0')]:
            result, record = self.run_builder(**versions)
            self.assertNotEqual(result.returncode, 0)
            self.assertIsNone(record)

    def test_current_stable_agave_uses_the_same_explicit_sbf_target(self):
        result, record = self.run_builder(cli='solana-cli 4.4.1 (fixture)')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('v3', record['args'])

    def test_protocol_selectors_cannot_enable_a_second_artifact(self):
        for selector in ('--protocol-v1', '--protocol-v2'):
            result, record = self.run_builder(overrides=(selector,))
            self.assertNotEqual(result.returncode, 0)
            self.assertIsNone(record)

    def test_raw_cargo_features_cannot_replace_the_selected_protocol_artifact(self):
        for v2 in (False, True):
            for overrides in [('--features', 'protocol-v2'), ('--features=protocol-v2',),
                              ('-Fprotocol-v2',), ('--all-features',), ('--features', 'no-entrypoint')]:
                result, record = self.run_builder(v2=v2, overrides=overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(record)

    def test_explicit_sbf_compiler_avoids_global_rustup_override(self):
        result, record = self.run_builder(compiler='/synthetic/platform-tools/rustc')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(record['args'][0], '--no-rustup-override')
        self.assertEqual(record['rustc'], '/synthetic/platform-tools/rustc')

    def test_signed_wire_operator_suites_run_after_node_and_dependencies(self):
        text = (ROOT / '.github/workflows/components.yml').read_text()
        components, integration = text.split('  integration:\n', 1)
        command = "python3 -B -m unittest discover -s ops -p 'test_*.py'"
        self.assertNotIn(command, components)
        self.assertEqual(integration.count(command), 2)
        self.assertLess(integration.index('actions/setup-node@'), integration.index('npm ci --prefix integration'))
        self.assertLess(integration.index('npm ci --prefix integration'), integration.index(command))
        self.assertIn('sudo env PATH="$PATH" GITHUB_ACTIONS=true CAPTURE402_SYSTEMD_TEST=1', integration)
        self.assertNotIn("-p 'test_reconcile_wire.py'", integration)

    def test_source_build_uses_locked_pinned_toolchain(self):
        for name in ('test-sac001.sh', 'test-sac002.sh', 'test-sac003.sh'):
            data = (ROOT / 'scripts' / name).read_text()
            self.assertIn('./scripts/build-sbf.sh', data)
            self.assertIn('cargo test --locked', data)
            self.assertNotIn('git show', data)
            self.assertNotIn('docs/evidence', data)

    def test_local_runner_rebuilds_before_integration(self):
        data = (ROOT / 'ops/dev_check.sh').read_text()
        self.assertLess(data.index('./scripts/test-sac003.sh'), data.index('npm test'))
        self.assertNotIn('git cat-file', data)
        self.assertNotIn('accepted=', data)

    def test_manual_public_workflow_builds_current_source_without_private_history(self):
        text = (ROOT / '.github/workflows/components.yml').read_text()
        self.assertIn('workflow_dispatch:', text)
        self.assertNotIn('  push:', text)
        self.assertNotIn('  pull_request:', text)
        self.assertIn('./scripts/build-sbf.sh', text)
        self.assertIn('cargo test --locked', text)
        self.assertIn('CAPTURE402_REPOSITORY_ID', text)
        self.assertIn('starPaw/capture402-solana', text)
        self.assertNotIn('git show', text)
        self.assertNotIn('docs/evidence', text)
        self.assertNotIn('Decide whether SBF rebuild is required', text)
