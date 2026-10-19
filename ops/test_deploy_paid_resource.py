"""Bounded paid-runtime installation contracts, entirely offline."""
import base64
import contextlib
import hashlib
import os
import json
import types
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import deploy_paid_resource as paid


class PaidInstallationTests(unittest.TestCase):
    def test_resource_waits_for_delayed_facilitator_http_readiness(self):
        events = []
        facilitator_probes = 0
        def probe(url):
            nonlocal facilitator_probes
            events.append(url)
            if ':38887/' in url:
                facilitator_probes += 1
                if facilitator_probes == 1:
                    raise OSError('dependency still starting')
                return (503 if facilitator_probes == 2 else 200), b'', {}
            self.assertEqual(facilitator_probes, 3)
            return 402, b'', {}
        with mock.patch.object(paid, 'run', side_effect=lambda *args: events.append(args)), \
                mock.patch.object(paid.source, 'response', side_effect=probe), \
                mock.patch.object(paid.time, 'sleep'):
            paid.start_runtime()
        self.assertEqual(events[0], ('systemctl', 'start', paid.USERS[0]))
        self.assertEqual(events[4], ('systemctl', 'start', paid.USERS[1]))
        self.assertEqual(events[-1], 'http://127.0.0.1:38888/resource')

    def test_unready_facilitator_never_starts_resource(self):
        with mock.patch.object(paid, 'run') as effect, \
                mock.patch.object(paid.source, 'response', side_effect=OSError('not ready')) as probe, \
                mock.patch.object(paid.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'readiness failed'):
                paid.start_runtime()
        effect.assert_called_once_with('systemctl', 'start', paid.USERS[0])
        self.assertEqual(probe.call_count, 20)

    def test_directory_modes_survive_private_install_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = os.umask(0o077)
            try:
                for name, mode in [('release', 0o755), ('private-role', 0o750), ('state-role', 0o700)]:
                    path = Path(tmp) / name
                    paid.directory(path, mode)
                    self.assertEqual(path.stat().st_mode & 0o777, mode)
                alias = Path(tmp) / 'alias'; alias.symlink_to(Path(tmp) / 'release')
                with self.assertRaisesRegex(RuntimeError, 'symlink'): paid.directory(alias)
            finally:
                os.umask(original)

    def test_continuation_accepts_only_empty_scaffold_and_preserves_manifests(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            root = Path(tmp)
            for name in ('BASE', 'PRIVATE', 'STATE'):
                path = root / name; path.mkdir()
                stack.enter_context(mock.patch.object(paid, name, path))
            for name in ('releases', 'manifests', 'acme'): (paid.BASE / name).mkdir()
            for name in ('before.json', 'approval.json'): (paid.BASE / 'manifests' / name).write_bytes(b'{"original":"retained"}')
            paid.empty_staging()
            for name in ('before.json', 'approval.json'):
                self.assertEqual((paid.BASE / 'manifests' / name).read_bytes(), b'{"original":"retained"}')
            for path in (paid.STATE / '.report-active.lock', paid.PRIVATE / 'key.json', paid.BASE / 'releases/artifact'):
                path.write_bytes(b'original UNKNOWN custody')
                with self.subTest(path=path.name), self.assertRaisesRegex(RuntimeError, 'continuation denied'):
                    paid.empty_staging()
                self.assertEqual(path.read_bytes(), b'original UNKNOWN custody')
                path.unlink()  # fixture cleanup only; installer never removes these files

    def test_program_preflight_requires_original_sbf_pointer_and_classic_mint(self):
        # Synthetic account bytes exercise refusal logic; live identity is a separate gate.
        binary = b'synthetic-sbf-fixture'
        alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        pointer = 0
        for char in paid.PROGRAM_DATA:
            pointer = pointer * 58 + alphabet.index(char)
        loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
        program = {'owner': loader, 'executable': True, 'data': [base64.b64encode((2).to_bytes(4, 'little') + pointer.to_bytes(32, 'big')).decode()]}
        # Match the accepted length while substituting only the test's expected hash.
        binary = binary.ljust(128, b'\0')
        pd = {'owner': loader, 'data': [base64.b64encode((3).to_bytes(4, 'little') + b'\0' * 41 + binary).decode()]}
        mint = {'owner': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                'data': [base64.b64encode(b'\0' * 44 + bytes([6, 1]) + b'\0' * 36).decode()]}
        for change in ('valid', 'pointer', 'binary', 'mint', 'loader'):
            import copy
            rows = copy.deepcopy([program, pd, mint])
            if change == 'pointer': rows[0]['data'] = [base64.b64encode(b'\0' * 36).decode()]
            if change == 'binary': rows[1]['data'] = [base64.b64encode((3).to_bytes(4, 'little') + b'\0' * 41 + b'X' * 128).decode()]
            if change == 'mint': rows[2]['data'] = [base64.b64encode(b'\0' * 82).decode()]
            if change == 'loader': rows[0]['owner'] = 'other'
            replies = [paid.GENESIS, 99, {'context': {'slot': 100}, 'value': rows}]
            with self.subTest(change=change), mock.patch.object(paid, 'SBF', hashlib.sha256(binary).hexdigest()), \
                    mock.patch.object(paid, 'rpc', side_effect=replies) as rpc:
                if change == 'valid':
                    self.assertEqual(paid.program_preflight('fixture')['contextSlot'], 100)
                else:
                    with self.assertRaises(RuntimeError): paid.program_preflight('fixture')
                self.assertEqual([c.args[1] for c in rpc.call_args_list], ['getGenesisHash', 'getSlot', 'getMultipleAccounts'])

    def test_zero_submission_and_disjoint_signing_state_configuration(self):
        facilitator, resource = paid.environments('https://fixture.quiknode.pro/private',
            Path('/opt/capture402-paid/releases/source/record.json'),
            {'facilitator': 'new-sponsor', 'resource': 'new-merchant'}, 'fixture-bearer')
        self.assertEqual(facilitator['SAC006_SPONSOR_MAX_ATTEMPTS'], '0')
        self.assertEqual(resource['SAC006_PAID_REPORT_ENABLED'], 'true')
        self.assertEqual(resource['SAC006_AUTHORIZE_AMOUNT'], '100000000')
        self.assertEqual(resource['SAC006_FEE_PAYER'], 'new-sponsor')
        self.assertEqual(facilitator['SAC006_ALLOWLIST_MERCHANT'], 'new-merchant')
        for config in (facilitator, resource):
            for key, value in config.items():
                if key.endswith(('_DIR', '_PATH')):
                    self.assertIn('/capture402-paid/', value)
            self.assertFalse(any('PAYER_KEYPAIR' in k or 'MINT_AUTHORITY' in k for k in config))

    def test_units_have_single_writer_paths_no_restart_or_boot_enablement(self):
        text = paid.unit(paid.USERS[0], Path('/opt/capture402-paid/releases/source'),
            'devnet-server.ts', Path('/etc/capture402-paid/facilitator/runtime.env'),
            Path('/var/lib/capture402-paid/facilitator'), Path('/opt/capture402-paid/bin/node'))
        self.assertIn('Restart=no\n', text)
        self.assertNotIn('[Install]', text)
        self.assertIn('ReadWritePaths=/var/lib/capture402-paid/facilitator\n', text)
        self.assertIn('NoNewPrivileges=true', text)
        self.assertIn('ExecStart=/opt/capture402-paid/bin/node ', text)
        for old in ('/var/lib/sac006', '/var/lib/capture402-dev', '/var/lib/capture402-e2e'):
            self.assertIn(old, text.split('InaccessiblePaths=', 1)[1])

    def test_tls_restriction_rejects_private_addresses_and_injection(self):
        for address in ('127.0.0.1', '10.0.0.1', '203.0.113.1', '8.8.8.8; allow all;', '::1'):
            with self.subTest(address=address), self.assertRaises((ValueError, RuntimeError)):
                paid.ingress(address, tls=True)
        text = paid.ingress('8.8.8.8', tls=True)
        self.assertIn('allow 8.8.8.8; allow 127.0.0.1; deny all;', text)
        self.assertIn('proxy_pass http://127.0.0.1:38888;', text)
        self.assertNotIn('38887', text)
        self.assertIn('limit_req zone=capture402_paid', text)

    def test_existing_deployment_pending_is_never_recovered(self):
        original_exists = Path.exists
        def exists(path):
            return str(path) == '/opt/capture402-dev/transaction.json' or original_exists(path)
        with mock.patch.object(Path, 'exists', exists), mock.patch.object(paid, 'run') as effect:
            with self.assertRaisesRegex(RuntimeError, 'existing deployment pending'): paid.no_pending()
        effect.assert_not_called()

    def test_rejects_public_rpc_and_wrong_genesis_before_other_reads(self):
        with mock.patch.object(paid.urllib.request, 'build_opener') as network:
            for endpoint in ('https://api.devnet.solana.com', 'http://fixture.quiknode.pro',
                             'https://user:secret@fixture.quiknode.pro'):
                with self.assertRaisesRegex(RuntimeError, 'explicit private provider'): paid.rpc(endpoint, 'getGenesisHash', [])
        network.assert_not_called()
        with mock.patch.object(paid, 'rpc', return_value='wrong-genesis') as rpc:
            with self.assertRaisesRegex(RuntimeError, 'wrong Devnet genesis'): paid.program_preflight('unused')
        self.assertEqual(rpc.call_count, 1)

    def test_rollback_stops_only_new_units_even_when_ingress_validation_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); config = root / 'new.conf'; config.write_text('fixture')
            enabled = root / 'enabled'; enabled.symlink_to(config)
            calls = []
            def run(*args):
                calls.append(args)
                if args == ('nginx', '-t'): raise RuntimeError('config failed')
            with mock.patch.object(paid, 'NGINX', config), mock.patch.object(paid, 'ENABLED', enabled), \
                    mock.patch.object(paid, 'run', side_effect=run):
                with self.assertRaisesRegex(RuntimeError, 'config failed'): paid.rollback()
            self.assertFalse(enabled.exists())
            self.assertEqual(calls[-1], ('systemctl', 'stop', 'capture402-paid-resource.service', 'capture402-paid-facilitator.service'))
            self.assertFalse(any(name in call for name in paid.OLD_SERVICES for call in calls))
            self.assertEqual(config.read_text(), 'fixture')

    def test_old_state_snapshot_observes_changes_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(paid, 'run', return_value='unchanged-process'):
            root = Path(tmp); state = root / 'pending.json'; state.write_bytes(b'original UNKNOWN')
            with mock.patch.object(paid, 'OLD_STATE', (root,)):
                first = paid.snapshot(); self.assertEqual(first, paid.snapshot())
                self.assertEqual(state.read_bytes(), b'original UNKNOWN')
                state.write_bytes(b'external change')
                self.assertNotEqual(first, paid.snapshot())

    def test_release_gate_refusal_precedes_namespace_mutation(self):
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(paid.os, 'geteuid', return_value=0))
            stack.enter_context(mock.patch.object(paid, '__file__', '/opt/capture402/controllers/' + 'a' * 40 + '/deploy_paid_resource.py'))
            stack.enter_context(mock.patch.object(paid, 'no_pending'))
            stack.enter_context(mock.patch.object(paid, 'node_source', return_value=(Path('/trusted/node'), 'v24.20.0')))
            stack.enter_context(mock.patch.object(Path, 'exists', return_value=False))
            stack.enter_context(mock.patch.object(paid.pwd, 'getpwnam', side_effect=KeyError))
            stack.enter_context(mock.patch.object(paid.socket, 'socket'))
            stack.enter_context(mock.patch.object(paid.cli, 'GitHub'))
            stack.enter_context(mock.patch.object(paid.policy, 'verify', side_effect=RuntimeError('release denied')))
            mutate = stack.enter_context(mock.patch.object(Path, 'mkdir'))
            run = stack.enter_context(mock.patch.object(paid, 'run'))
            with self.assertRaisesRegex(RuntimeError, 'release denied'):
                paid.install('a' * 40, '8.8.8.8')
            mutate.assert_not_called(); run.assert_not_called()

    def test_missing_runtime_fails_before_namespace_mutation(self):
        with mock.patch.object(Path, 'exists', return_value=False), mock.patch.object(paid, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Node 24 not found'): paid.node_source()
        run.assert_not_called()

    def test_runtime_resolution_accepts_operator_binary_and_rejects_writable_or_wrong_major(self):
        with tempfile.TemporaryDirectory() as tmp:
            executable=Path(tmp)/'node';executable.write_bytes(b'fixture');executable.chmod(0o755)
            original_path=Path
            def path(value):
                return executable if str(value)=='/usr/local/bin/node' else original_path(value)
            with mock.patch.object(paid,'Path',side_effect=path), \
                    mock.patch.object(paid.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())), \
                    mock.patch.object(paid,'run',return_value='v24.20.0') as run:
                self.assertEqual(paid.node_source(),(executable.resolve(),'v24.20.0'))
                executable.chmod(0o777)
                with self.assertRaisesRegex(RuntimeError,'unsafe installed Node'):paid.node_source()
                executable.chmod(0o755);run.return_value='v22.1.0'
                with self.assertRaisesRegex(RuntimeError,'Node 24 required'):paid.node_source()

    def test_sealed_node_copy_preserves_source_and_ignores_private_umask(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(paid, 'run', return_value='v24.20.0'):
            root = Path(tmp); source = root / 'installed-node'; original = b'synthetic executable fixture'
            source.write_bytes(original)
            base = root / 'paid'; base.mkdir()
            with mock.patch.object(paid, 'BASE', base):
                previous = os.umask(0o077)
                try:target, identity = paid.seal_node(source, 'v24.20.0')
                finally:os.umask(previous)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(target.stat().st_mode & 0o777, 0o755)
            self.assertEqual(identity['sha256'], hashlib.sha256(original).hexdigest())

    def test_specific_prekey_continuation_retains_users_and_rejects_key_or_manifest_change(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            root = Path(tmp)
            for name in ('BASE','PRIVATE','STATE'):
                path=root/name;path.mkdir();stack.enter_context(mock.patch.object(paid,name,path))
            for name in ('releases','manifests','acme'):(paid.BASE/name).mkdir()
            (paid.BASE/'releases'/paid.PREKEY_SOURCE).mkdir()
            for parent in (paid.PRIVATE,paid.STATE):
                for role in ('facilitator','resource'):(parent/role).mkdir()
            marker={'schema':1,'source':paid.PREKEY_SOURCE,'reason':'NODE_EXECUTABLE_ABSENT_BEFORE_KEY_GENERATION','manifests':{},'users':{}}
            names=['before.json','approval.json','before-'+paid.PREKEY_SOURCE+'.json','approval-'+paid.PREKEY_SOURCE+'.json',paid.PREKEY_SOURCE+'.json']
            for name in names:
                (paid.BASE/'manifests'/name).write_bytes(b'original manifest')
                marker['manifests'][name]=hashlib.sha256(b'original manifest').hexdigest()
            for name in paid.USERS:marker['users'][name]={'uid':99,'gid':98}
            (paid.BASE/'manifests/prekey-stop.json').write_text(json.dumps(marker))
            stack.enter_context(mock.patch.object(paid.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=99,pw_gid=98,pw_shell='/usr/sbin/nologin')))
            paid.prekey_staging()
            key=paid.PRIVATE/'resource/key.json';key.write_bytes(b'original key custody')
            with self.assertRaisesRegex(RuntimeError,'continuation denied'):paid.prekey_staging()
            self.assertEqual(key.read_bytes(),b'original key custody');key.unlink()  # fixture cleanup only
            (paid.BASE/'manifests'/names[0]).write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError,'manifest changed'):paid.prekey_staging()


if __name__ == '__main__': unittest.main()


def setUpModule():
    global _installation_fixture
    from operator_test_fixture import install
    _installation_fixture = install()
    global _prekey_fixture
    _prekey_fixture = mock.patch.object(paid, "PREKEY_SOURCE", "a" * 40)
    _prekey_fixture.start()


def tearDownModule():
    _prekey_fixture.stop()
    _installation_fixture.stop()
