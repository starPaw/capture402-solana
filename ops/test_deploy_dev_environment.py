"""Dev routing, authority and isolation configuration regressions; no live operations."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import dev_environment as dev


class DevEnvironmentTests(unittest.TestCase):
    def test_private_generation_cannot_write_secrets_into_git(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(dev, 'PROJECT', root/'checkout'):
                with self.assertRaises(ValueError): dev.validate_private_output(root/'checkout/private')
                dev.validate_private_output(root/'operator-private')

    def test_private_environment_binds_only_dev_roles_and_separate_credentials(self):
        identities = {role: char*32 for role, char in zip(['sponsor', 'merchant', 'payer', 'mint'], '1234')}
        endpoint = 'https://fixture.solana-devnet.quiknode.pro/fixture-only/'
        files = dev.private_environments('dev.example.invalid', identities, 'f'*64, 'm'*64, rpc_url=endpoint)
        for role in ['facilitator', 'restaurant']:
            self.assertIn('SOLANA_RPC_URL='+endpoint+'\n', files[role+'.env'])
        self.assertIn('SAC006_FEE_PAYER='+identities['sponsor'], files['restaurant.env'])
        self.assertIn('SAC006_ALLOWLIST_MERCHANT='+identities['merchant'], files['facilitator.env'])
        self.assertIn('SAC006_MERCHANT_TOKEN='+'m'*64, files['restaurant.env'])
        self.assertNotIn('SAC006_MERCHANT_TOKEN=', files['facilitator.env'])
        with self.assertRaises(ValueError): dev.private_environments('dev.example.invalid', identities, 'f'*64, 'f'*64, rpc_url=endpoint)
        with self.assertRaises(ValueError): dev.private_environments('dev.example.invalid', identities, 'weak', 'also-weak', rpc_url=endpoint)
        identities['payer'] = identities['sponsor']
        with self.assertRaises(ValueError): dev.private_environments('dev.example.invalid', identities, 'f'*64, 'm'*64, rpc_url=endpoint)

    def test_private_environment_requires_provider_and_refuses_public_or_injected_rpc(self):
        identities = {role: char*32 for role, char in zip(['sponsor', 'merchant', 'payer', 'mint'], '1234')}
        with mock.patch.dict(dev.os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'configured HTTPS'):
                dev.private_environments('dev.example.invalid', identities, 'f'*64, 'm'*64)
        for endpoint in ['', 'https://api.devnet.solana.com', 'http://devnet.helius-rpc.com/',
                         'https://user:password@devnet.helius-rpc.com/',
                         'https://devnet.helius-rpc.com/\nSAC006_PORT=8787']:
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(ValueError, 'configured HTTPS'):
                dev.private_environments('dev.example.invalid', identities, 'f'*64, 'm'*64, rpc_url=endpoint)

    def test_private_environment_uses_configured_helius_in_both_roles(self):
        identities = {role: char*32 for role, char in zip(['sponsor', 'merchant', 'payer', 'mint'], '1234')}
        endpoint = 'https://devnet.helius-rpc.com/?api-key=fixture-only'
        with mock.patch.dict(dev.os.environ, {'SOLANA_RPC_URL': endpoint}):
            files = dev.private_environments('dev.example.invalid', identities, 'f'*64, 'm'*64)
        self.assertTrue(all('SOLANA_RPC_URL='+endpoint+'\n' in value for value in files.values()))

    def test_render_dev_only_ports_and_origin(self):
        files = dev.render('dev.example.invalid')
        dev.verify_layout(files)
        self.assertIn('SAC006_PORT=18887\n', files['facilitator.env.example'])
        self.assertIn('SAC006_RESOURCE_PORT=18888\n', files['restaurant.env.example'])
        self.assertIn('SAC006_PUBLIC_ORIGIN=https://dev.example.invalid\n', files['restaurant.env.example'])
        self.assertIn('SAC006_FACILITATOR_URL=http://127.0.0.1:18887\n', files['restaurant.env.example'])

    def test_reject_live_hostname_and_nginx_injection(self):
        for host in ['example.invalid', 'www.example.invalid', 'dev.example.invalid; return 200;',
                     'dev.example.invalid\nserver {}', 'https://dev.example.invalid', '../example.com', '']:
            with self.subTest(host=host), self.assertRaises(ValueError):
                dev.render(host)

    def test_access_allowlist_is_private_by_default(self):
        self.assertEqual(dev.access_config([]), 'allow 127.0.0.1;\nallow ::1;\ndeny all;\n')
        self.assertIn('allow 192.0.2.2/32;\n', dev.access_config(['192.0.2.2']))
        for net in ['0.0.0.0/0', '::/0', '192.0.2.1; allow all']:
            with self.subTest(net=net), self.assertRaises(ValueError):
                dev.access_config([net])

    def test_refuses_live_or_facilitator_upstream(self):
        for port in [8788, 8787, 18887]:
            files = dev.render('dev.example.invalid')
            files['nginx-routes.conf'] = files['nginx-routes.conf'].replace(':18888', f':{port}')
            with self.subTest(port=port), self.assertRaises(ValueError):
                dev.verify_layout(files)

    def test_missing_proxy_retry_guard_is_refused(self):
        files = dev.render('dev.example.invalid')
        files['nginx-routes.conf'] = files['nginx-routes.conf'].replace('proxy_next_upstream off;', '')
        with self.assertRaises(ValueError): dev.verify_layout(files)

    def test_service_roles_and_key_access_are_separate(self):
        files = dev.render('dev.example.invalid')
        facilitator = files['capture402-dev-facilitator.service']
        restaurant = files['capture402-dev-restaurant.service']
        self.assertIn('User=capture402-dev-facilitator\n', facilitator)
        self.assertIn('User=capture402-dev-restaurant\n', restaurant)
        self.assertIn('/etc/capture402-dev/keys/sponsor.json', restaurant)
        self.assertIn('/etc/capture402-dev/keys/merchant.json', facilitator)
        for unit in [facilitator, restaurant]:
            self.assertIn('Slice=capture402-dev.slice\n', unit)
            self.assertIn('InaccessiblePaths=/etc/sac006 /var/lib/sac006 /opt/capture402 /opt/capture402-legacy\n', unit)
            self.assertNotIn('--inspect=', unit)

    def test_debugger_bindings_are_loopback_and_opt_in(self):
        files = dev.render('dev.example.invalid')
        self.assertIn('--inspect=127.0.0.1:19227', files['debug-facilitator.conf'])
        self.assertIn('--inspect=127.0.0.1:19228', files['debug-restaurant.conf'])

    def test_prepare_cannot_overwrite_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/'prepared'
            files = dev.render('dev.example.invalid')
            dev.write_assets(output, files)
            self.assertEqual((output/'nginx-site.conf').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): dev.write_assets(output, files)


class E2EEnvironmentTests(unittest.TestCase):
    def test_disjoint_profile_and_default_closed_ingress(self):
        files = dev.render('e2e.example.invalid', profile='e2e')
        dev.verify_layout(files, profile='e2e')
        for role in ['facilitator', 'restaurant']:
            unit = files[f'capture402-e2e-{role}.service']
            self.assertIn(f'User=capture402-e2e-{role}\n', unit)
            self.assertIn('/opt/capture402-e2e/current/integration', unit)
            self.assertIn('/etc/capture402-dev /var/lib/capture402-dev /opt/capture402-dev', unit)
            self.assertNotIn('[Install]', unit)
            self.assertNotIn('--inspect', unit)
        self.assertIn('SAC006_PORT=28887\n', files['facilitator.env.example'])
        self.assertIn('SAC006_RESOURCE_PORT=28888\n', files['restaurant.env.example'])
        self.assertIn('SAC006_PUBLIC_ORIGIN=https://e2e.example.invalid\n', files['restaurant.env.example'])
        self.assertNotIn('debug-facilitator.conf', files)
        self.assertEqual(files['nginx-access.conf'], dev.access_config([]))

    def test_wrong_host_and_profile_fail_closed(self):
        for host in ['dev.example.invalid', 'other.example.invalid', 'example.invalid']:
            with self.subTest(host=host), self.assertRaises(ValueError):
                dev.render(host, profile='e2e')
        with self.assertRaises(ValueError): dev.render('e2e.example.invalid', profile='wrong')

    def test_stale_or_cross_environment_assets_refused(self):
        expected = dev.render('e2e.example.invalid', profile='e2e')
        for name, content in expected.items():
            if name == 'nginx-access.conf': continue
            files = dict(expected)
            files[name] = content.replace('capture402-e2e', 'capture402-dev') if 'capture402-e2e' in content else content + '# stale\n'
            with self.subTest(name=name), self.assertRaises(ValueError):
                dev.verify_layout(files, profile='e2e')
        for allowlist in ['allow all;\ndeny all;\n', 'allow 0.0.0.0/0;\ndeny all;\n', 'allow 127.0.0.1;\n']:
            files = dict(expected); files['nginx-access.conf'] = allowlist
            with self.assertRaises(ValueError): dev.verify_layout(files, profile='e2e')

    def test_explicit_bounded_admission(self):
        files = dev.render('e2e.example.invalid', ['192.0.2.4'], profile='e2e')
        dev.verify_layout(files, profile='e2e')
        self.assertIn('allow 192.0.2.4/32;', files['nginx-access.conf'])


if __name__ == '__main__': unittest.main()


def setUpModule():
    global _installation_fixture
    from operator_test_fixture import install
    _installation_fixture = install()


def tearDownModule():
    _installation_fixture.stop()
