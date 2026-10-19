"""A recovery record never broadens clean-state admission or #57 UNKNOWN AUTHORIZE."""
from test_deploy_dev import DevFixture
import deploy_dev as dev

class PayerRecoveryPreflightTests(DevFixture):
    def test_recovery_and_arbitrary_records_are_not_skipped(self):
        orders = dev.state_paths()[3]
        for name in ('a' * 32 + '.payer-recovery-' + 'b' * 64 + '.record', 'unknown.record', 'a' * 32 + '.payer-recovery-corrupt.record'):
            with self.subTest(name=name):
                path = orders / name
                path.write_text('{}')
                before = self.snapshot()
                with self.assertRaises(RuntimeError): dev.clean_operations()
                self.assertEqual(self.snapshot(), before)
                path.unlink()


def setUpModule():
    global _installation_fixture
    from operator_test_fixture import install
    _installation_fixture = install()


def tearDownModule():
    _installation_fixture.stop()
