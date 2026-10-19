"""Public CI builds current source; it never imports historical acceptance artifacts."""
from pathlib import Path
import unittest
ROOT = Path(__file__).resolve().parents[1]

class SourceBuildTests(unittest.TestCase):
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
            self.assertIn('cargo-build-sbf --tools-version v1.53 --arch v0 -- --locked', data)
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
        self.assertIn('cargo-build-sbf --tools-version v1.53 --arch v0 -- --locked', text)
        self.assertIn('cargo test --locked --test sac001 --test sac002 --test sac003', text)
        self.assertIn('CAPTURE402_REPOSITORY_ID', text)
        self.assertIn('starPaw/capture402-solana', text)
        self.assertNotIn('git show', text)
        self.assertNotIn('docs/evidence', text)
        self.assertNotIn('Decide whether SBF rebuild is required', text)
