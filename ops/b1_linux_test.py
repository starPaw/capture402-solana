# Synthetic local Linux fault fixture; identifiers are deterministic examples, not operational records.
#!/usr/bin/env python3
"""Execute B1 README bodies only on an explicitly marked disposable Linux VM.

Synthetic identities/credentials stay inside the VM. Never run on a VPS.
Source and dependency archives must be staged separately before this harness.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import shutil
import subprocess
import sys

SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
R = Path('/opt/capture402-e2e/releases') / SHA
D = Path('/etc/capture402-e2e')
S = Path('/var/lib/capture402-e2e/setup')
P = Path('/root/capture402-b1-package')
OUT = Path('/root/b1-results.json')
NODE = '/opt/node-v24.20.0-linux-arm64/bin/node'
OLD = ['/etc/sac006', '/var/lib/sac006', '/opt/capture402', '/opt/capture402-legacy',
       '/etc/capture402-dev', '/var/lib/capture402-dev', '/opt/capture402-dev', '/home/capture402-dev']
TESTS = []


def digest(p):
    return hashlib.file_digest(Path(p).open('rb'), 'sha256').hexdigest()


def run(args, *, input=None, ok=True):
    p = subprocess.run(args, input=input, capture_output=True, text=True, timeout=180)
    if ok and p.returncode:
        raise RuntimeError('command refused: ' + ' '.join(args[:2]) + ': ' + p.stderr[-700:])
    return p


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def save():
    OUT.write_text(json.dumps({'scope': 'DISPOSABLE_SYNTHETIC_ONLY_NOT_VPS',
        'readme_sha256': digest(P / 'README.md'), 'harness_sha256': digest(__file__),
        'source': SHA, 'node_sha256': digest(NODE), 'node_version': run([NODE, '--version']).stdout.strip(),
        'systemd': run(['systemctl', '--version']).stdout.splitlines()[0],
        'os': run(['uname', '-sr']).stdout.strip(), 'tests': TESTS,
        'counts': {s: sum(t['result'] == s for t in TESTS) for s in ['PASS', 'FAIL']}}, indent=2) + '\n')


def check(name, action):
    try:
        action()
        TESTS.append({'name': name, 'result': 'PASS'})
    except Exception:
        TESTS.append({'name': name, 'result': 'FAIL'})
        save()
        raise
    save()
    print('PASS ' + name, flush=True)


def body(code, *, ok=True):
    return run(['bash', '-seu'], input=PREFIX + code, ok=ok)


def offline(code, *, ok=True):
    return body(SANDBOX + '\nb1_offline /usr/bin/python3 -I - <<\'PROBE\'\n' + code + '\nPROBE\n', ok=ok)


def refused(code):
    p = body(code, ok=False)
    require(p.returncode != 0 and not (D / 'b1-reservation.json').exists(), 'refusal wrote reservation')


def write(p, content, mode=0o600):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    p.chmod(mode)


def reset_fixture():
    # This is deliberately VM-only fixture cleanup, never an operator recovery action.
    shutil.rmtree(D)
    shutil.rmtree(S)
    D.mkdir(mode=0o750)
    (D / 'keys').mkdir(mode=0o750)
    for p in [D, D / 'keys']:
        os.chown(p, 0, 986)
    S.mkdir(mode=0o700)


def guard_mutation(name, mutate, restore):
    mutate()
    try:
        check(name, lambda: refused(BLOCKS[0]))
    finally:
        restore()


def final_refusal(name, mutate, restore):
    mutate()
    try:
        p = body(BLOCKS[5], ok=False)
        check(name, lambda: require(p.returncode != 0 and not (D / 'b1-complete.json').exists(), 'invalid completion accepted'))
    finally:
        restore()


def main():
    global BLOCKS, PREFIX, SANDBOX
    marker = Path('/etc/capture402-b1-disposable')
    require(os.getuid() == 0 and marker.read_text().strip() == 'DISPOSABLE_SYNTHETIC_B1_TEST_ONLY', 'marked disposable VM required')
    require(run(['hostname']).stdout.strip() == 'capture402-b1-disposable', 'unexpected host')
    BLOCKS = re.findall(r'```bash\n(.*?)\n```', (P / 'README.md').read_text(), re.S)
    require(len(BLOCKS) == 6, 'unexpected operator block inventory')
    PREFIX = 'set -euo pipefail\nset +x\numask 077\nexport PATH=/usr/sbin:/usr/bin:/sbin:/bin\n' + ''.join(
        f'export B1_{k}={v}\n' for k, v in [('PACKAGE', P), ('RELEASE', R), ('PRIVATE', D), ('SETUP', S)])
    SANDBOX = BLOCKS[1].rsplit('\nb1_offline "$B1_NODE"', 1)[0]
    for group, gid in [('capture402-e2e-runtime', 986)]:
        try:
            require(grp.getgrnam(group).gr_gid == gid, 'fixture group drift')
        except KeyError:
            run(['groupadd', '-g', str(gid), group])
    for user, uid, gid in [('capture402-e2e-facilitator', 989, 986), ('capture402-e2e-restaurant', 988, 986),
                           ('b1-fixture-old', 987, 986)]:
        try:
            existing = pwd.getpwuid(uid)
        except KeyError:
            existing = None
        if existing:
            # Cloud-image system users can occupy the accepted VPS numeric IDs.
            # Relocate only those VM fixture identities before the campaign.
            require(existing.pw_name != user, 'campaign already initialized; retain results')
            if existing.pw_name == 'polkitd':
                run(['systemctl', 'stop', 'polkit.service'])
            run(['usermod', '-u', str(5000 + uid), existing.pw_name])
        run(['useradd', '-u', str(uid), '-g', str(gid), '-M', '-s', '/usr/sbin/nologin', user])
    for root in OLD:
        write(Path(root) / 'b1-marker', 'SYNTHETIC_OLD_STATE', 0o644)
    (R.parent.parent / 'current').symlink_to(R)
    D.mkdir(mode=0o750)
    (D / 'keys').mkdir(mode=0o750)
    for p in [D, D / 'keys']:
        os.chown(p, 0, 986)
    S.mkdir(parents=True, mode=0o700)
    write(P / 'old-public.json', json.dumps(['11111111111111111111111111111111']))
    write(P / 'sandbox.json', json.dumps({'scope': 'SYNTHETIC_CAMPAIGN_INPUT_ONLY'}))
    files = sorted({p.resolve() for p in (R / 'integration/node_modules').rglob('*') if p.is_file()})
    write(P / 'runtime.sha256', ''.join(digest(p) + '  ' + str(p) + '\n' for p in files))
    approved = {'approval_reference': 'DISPOSABLE_SYNTHETIC_ONLY', 'package_manifest_sha256': digest(P / 'SHA256SUMS'),
        'host': 'capture402-b1-disposable', 'package_source_revision': SHA, 'node_path': NODE, 'node_sha256': digest(NODE), 'old_runtime_users': ['b1-fixture-old']}
    for name, path in [('runtime_manifest', P / 'runtime.sha256'), ('old_public_ids', P / 'old-public.json'), ('sandbox_evidence', P / 'sandbox.json')]:
        approved[name + '_path'] = str(path)
        approved[name + '_sha256'] = digest(path)
    approval = json.dumps(approved)
    write(P / 'approved.json', approval)
    for role in ['facilitator', 'restaurant']:
        write(Path('/etc/systemd/system') / f'capture402-e2e-{role}.service', '[Service]\nType=oneshot\nExecStart=/usr/bin/true\n', 0o644)
    run(['systemctl', 'daemon-reload'])
    probe = """import pathlib,socket,os
for root in ['/etc/capture402-e2e','/var/lib/capture402-e2e/setup','/tmp']:
 p=pathlib.Path(root)/'allowed-probe';p.write_text('SYNTHETIC');p.unlink()
for root in %s:
 try: (pathlib.Path(root)/'b1-marker').read_text()
 except OSError: pass
 else: raise SystemExit('old root readable')
for path in ['%s/integration/package.json','/etc/hosts']:
 try:
  with open(path,'r+b'): pass
 except OSError: pass
 else: raise SystemExit('outside write allowed')
for family in [socket.AF_INET,socket.AF_INET6]:
 try: socket.socket(family,socket.SOCK_STREAM)
 except OSError: pass
 else: raise SystemExit('network family allowed')
assert 'CapEff:\\t0000000000000000' in pathlib.Path('/proc/self/status').read_text()
""" % (repr(OLD), R)
    check('allowed-private-setup-tmp-writes-denied-network-old-roots-release-host-writes-zero-capabilities', lambda: offline(probe))
    bad = SANDBOX.replace('ReadWritePaths="$B1_PRIVATE $B1_SETUP"', 'ReadWritePaths=/nonexistent-b1-required-path')
    p = body(bad + '\nb1_offline /usr/bin/touch /etc/capture402-e2e/should-not-execute\n', ok=False)
    check('sandbox-setup-failure-stops-before-child', lambda: require(p.returncode != 0 and not (D / 'should-not-execute').exists(), 'child executed'))
    for args in ['keys', 'keys --profile dev', 'keys --profile invalid', 'keys --profile']:
        p = body(SANDBOX + f'\nb1_offline "$B1_NODE" --experimental-strip-types "$B1_RELEASE/integration/operators/dev-environment.ts" {args}\n', ok=False)
        check('refuse-profile-' + args.replace(' ', '-'), lambda p=p: require(p.returncode != 0 and not list((D / 'keys').iterdir()), 'wrong profile wrote keys'))
    for field in ['node_sha256', 'package_manifest_sha256', 'runtime_manifest_sha256', 'old_public_ids_sha256', 'sandbox_evidence_sha256']:
        guard_mutation('guard-wrong-' + field, lambda field=field: write(P / 'approved.json', json.dumps({**approved, field: '0' * 64})), lambda: write(P / 'approved.json', approval))
    guard_mutation('guard-wrong-host', lambda: write(P / 'approved.json', json.dumps({**approved, 'host': 'wrong-host'})), lambda: write(P / 'approved.json', approval))
    ingress = Path('/etc/nginx/conf.d/b1-e2e.conf')
    guard_mutation('guard-included-e2e-ingress', lambda: write(ingress, 'server {listen 127.0.0.1:29001; server_name e2e.example.invalid;}\n', 0o644), lambda: ingress.unlink())
    guard_mutation('guard-untrusted-interpreter-owner', lambda: os.chown(NODE, 987, 986), lambda: os.chown(NODE, 0, 0))
    guard_mutation('guard-writable-release', lambda: (R / 'integration/package.json').chmod(0o666), lambda: (R / 'integration/package.json').chmod(0o644))
    manifest = (P / 'runtime.sha256').read_text()
    incomplete = ''.join(manifest.splitlines(keepends=True)[1:])
    def incomplete_input():
        write(P / 'runtime.sha256', incomplete)
        write(P / 'approved.json', json.dumps({**approved, 'runtime_manifest_sha256': digest(P / 'runtime.sha256')}))
    def restore_input():
        write(P / 'runtime.sha256', manifest)
        write(P / 'approved.json', approval)
    guard_mutation('guard-incomplete-approved-runtime-inventory', incomplete_input, restore_input)
    guard_mutation('guard-preexisting-partial-key', lambda: write(D / 'keys/sponsor.json', 'SYNTHETIC_PARTIAL'), lambda: (D / 'keys/sponsor.json').unlink())
    check('exclusive-durable-reservation', lambda: body(BLOCKS[0]))
    p = body(BLOCKS[0], ok=False)
    check('reservation-refuses-second-ceremony', lambda: require(p.returncode != 0, 'reservation repeated'))
    interrupted = SANDBOX + '''
b1_offline "$B1_NODE" --experimental-strip-types --input-type=module - <<'JS'
import {Keypair} from '@solana/web3.js';
import {prepareKeys} from './operators/dev-environment.ts';
const original=Keypair.generate; let n=0;
Keypair.generate=()=>{if (++n===2) throw Error('SYNTHETIC_INTERRUPTION'); return original.call(Keypair);};
try {prepareKeys('/etc/capture402-e2e');} catch {process.exitCode=1;}
JS
'''
    p = body(interrupted, ok=False)
    require(p.returncode != 0 and (D / 'keys/sponsor.json').is_file() and not (D / 'identities.json').exists(), 'partial fixture did not interrupt')
    h = digest(D / 'keys/sponsor.json')
    p = body(BLOCKS[1], ok=False)
    check('interrupted-generation-retains-first-key-and-refuses-regeneration', lambda: require(p.returncode != 0 and digest(D / 'keys/sponsor.json') == h and len(list((D / 'keys').iterdir())) == 1, 'partial state replaced'))
    reset_fixture()
    check('fresh-synthetic-reservation', lambda: body(BLOCKS[0]))
    check('explicit-e2e-key-generation', lambda: body(BLOCKS[1]))
    original_ids = (D / 'identities.json').read_text()
    ids = json.loads(original_ids)
    write(D / 'identities.json', json.dumps({**ids, 'sponsor': ids['merchant']}))
    p = body(SANDBOX + '\n' + BLOCKS[2], ok=False)
    check('mismatched-private-public-pair-refused-before-custody', lambda: require(p.returncode != 0 and (D / 'keys/sponsor.json').stat().st_uid == 0, 'bad pair accepted'))
    write(D / 'identities.json', original_ids)
    check('four-private-public-pairs-match-before-custody', lambda: body(SANDBOX + '\n' + BLOCKS[2]))
    check('seal-custody', lambda: body(BLOCKS[3]))
    p = body(SANDBOX + '\n' + BLOCKS[2], ok=False)
    check('capability-free-root-cannot-read-transferred-sponsor', lambda: require(p.returncode != 0, 'post-transfer key readable'))
    check('two-private-environments-only', lambda: body(SANDBOX + '\n' + BLOCKS[4]))
    h = {n: digest(D / n) for n in ['facilitator.env', 'restaurant.env']}
    p = body(SANDBOX + '\n' + BLOCKS[4], ok=False)
    check('private-env-recreation-refused-and-bytes-retained', lambda: require(p.returncode != 0 and h == {n: digest(D / n) for n in h}, 'env replaced'))
    final_refusal('group-readable-sponsor-refused', lambda: (D / 'keys/sponsor.json').chmod(0o640), lambda: (D / 'keys/sponsor.json').chmod(0o600))
    final_refusal('wrong-key-custody-refused', lambda: os.chown(D / 'keys/merchant.json', 989, 986), lambda: os.chown(D / 'keys/merchant.json', 988, 986))
    final_refusal('extended-acl-refused', lambda: run(['setfacl', '-m', 'u:b1-fixture-old:r', str(D / 'restaurant.env')]), lambda: run(['setfacl', '-b', str(D / 'restaurant.env')]))
    final_refusal('approval-digest-drift-refused', lambda: write(P / 'sandbox.json', 'DRIFT'), lambda: write(P / 'sandbox.json', json.dumps({'scope': 'SYNTHETIC_CAMPAIGN_INPUT_ONLY'})))
    final_refusal('identity-drift-refused', lambda: write(D / 'identities.json', json.dumps({**ids, 'mint': ids['merchant']})), lambda: write(D / 'identities.json', original_ids))
    final_refusal('economic-setup-reservation-refused', lambda: write(S / 'funding.json', 'SYNTHETIC_FORBIDDEN'), lambda: (S / 'funding.json').unlink())
    for n in ['facilitator.env', 'restaurant.env']:
        content = (D / n).read_text()
        final_refusal('wrong-config-refused-' + n, lambda n=n, content=content: write(D / n, content.replace('28887', '18887')), lambda n=n, content=content: write(D / n, content))
    reservation = (D / 'b1-reservation.json').read_text()
    final_refusal('reservation-binding-drift-refused', lambda: write(D / 'b1-reservation.json', '{}'), lambda: write(D / 'b1-reservation.json', reservation))
    final_refusal('extra-identity-field-refused', lambda: write(D / 'identities.json', json.dumps({**ids, 'extra': ids['mint']})), lambda: write(D / 'identities.json', original_ids))
    before = {str(p.relative_to(R)): digest(p) for p in R.rglob('*') if p.is_file()}
    check('final-effective-role-and-old-common-group-read-matrix-durable-receipt', lambda: body(BLOCKS[5]))
    after = {str(p.relative_to(R)): digest(p) for p in R.rglob('*') if p.is_file()}
    check('verification-preserves-entire-sealed-release-no-bytecode-writes', lambda: require(before == after, 'verification mutated release'))
    receipt = json.loads((D / 'b1-complete.json').read_text())
    require(len(receipt['access_checks']) == 21 and receipt['status'] == 'OFFLINE_B1_VERIFIED_B2_B3_NOT_RUN', 'bounded receipt mismatch')
    check('completion-receipt-exclusive', lambda: require(body(BLOCKS[5], ok=False).returncode != 0, 'receipt overwritten'))
    check('no-economic-setup-or-application-activation', lambda: require(not list(S.iterdir()) and all(run(['systemctl', 'is-active', f'capture402-e2e-{r}'], ok=False).stdout.strip() == 'inactive' for r in ['facilitator', 'restaurant']), 'economic/app activity'))


if __name__ == '__main__':
    main()
