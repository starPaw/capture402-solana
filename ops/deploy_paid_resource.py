#!/usr/bin/env python3
"""Owner-authorized, zero-submission installation of a fourth Devnet runtime.

Run only from the exact installed, release-eligible private controller directory.
Rollback stops this runtime and removes its ingress; it never restores state.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
import deployment_config
from pathlib import Path
import pwd
import re
import secrets
import socket
import subprocess
import time
import urllib.parse
import urllib.request

import deploy_demo as source
import deploy_vps as host
import host_cli as cli
import release_policy as policy

BASE = Path('/opt/capture402-paid')
PRIVATE = Path('/etc/capture402-paid')
STATE = Path('/var/lib/capture402-paid')
NGINX = Path('/etc/nginx/sites-available/capture402-paid.conf')
ENABLED = Path('/etc/nginx/sites-enabled/capture402-paid.conf')
ORIGIN = deployment_config.optional('paidOrigin', 'https://paid.example.invalid')
DOMAIN = __import__('urllib.parse', fromlist=['urlsplit']).urlsplit(ORIGIN).hostname
USERS = ('capture402-paid-facilitator', 'capture402-paid-resource')
OLD_STATE = (Path('/var/lib/sac006'), Path('/var/lib/capture402-dev'), Path('/var/lib/capture402-e2e'))
OLD_SERVICES = ('capture402-facilitator', 'capture402-restaurant',
                'capture402-dev-facilitator', 'capture402-dev-restaurant',
                'capture402-e2e-facilitator', 'capture402-e2e-restaurant')
RPC_CONFIG = Path('/etc/capture402-e2e/facilitator.env')
MINT = deployment_config.optional('paidMint')
SBF = deployment_config.optional('acceptedExecutableSha256')
GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
PROGRAM = deployment_config.optional('programId')
PROGRAM_DATA = deployment_config.optional('programData')
PREKEY_SOURCE = deployment_config.optional('paidPrekeySource')


def run(*args, **kwargs):
    # subprocess bodies can contain private configuration; never print them.
    result = subprocess.run(args, capture_output=True, text=True, check=True, timeout=300, **kwargs)
    return result.stdout.strip()


def write(path, data, mode=0o600):
    source.require(not path.exists() and not path.is_symlink(), 'new file already exists; inspect retained installation')
    host.atomic_bytes(path, data.encode() if isinstance(data, str) else data, mode)


def directory(path, mode=0o755):
    """Set the intended mode explicitly even under the install unit's UMask=0077."""
    source.require(not path.is_symlink(), 'managed directory is symlink')
    path.mkdir(mode=mode, exist_ok=True)
    path.chmod(mode)


def empty_staging():
    """Permit only the exact pre-build scaffold; never reuse economic state."""
    for root in (BASE, PRIVATE, STATE):
        source.require(root.is_dir() and not root.is_symlink(), 'missing empty staging root')
    source.require({p.name for p in BASE.iterdir()} == {'releases', 'manifests', 'acme'}, 'unexpected staging entries')
    for path in (BASE / 'releases', BASE / 'acme', PRIVATE, STATE):
        source.require(path.is_dir() and not path.is_symlink() and not any(path.iterdir()),
                       'staging contains files/state; continuation denied')
    manifests = BASE / 'manifests'
    source.require(manifests.is_dir() and not manifests.is_symlink()
                   and {p.name for p in manifests.iterdir()} == {'before.json', 'approval.json'},
                   'unexpected original staging manifests')
    for name in ('before.json', 'approval.json'):
        path = manifests / name
        source.require(path.is_file() and not path.is_symlink(), 'unsafe original staging manifest')
        source.require(isinstance(json.loads(path.read_text()), dict), 'invalid original staging manifest')


def node_source():
    """Select the installed Node 24 before staging; do not assume /usr/bin/node."""
    for candidate in (Path('/usr/local/bin/node'), Path('/usr/bin/node')):
        if not candidate.exists():
            continue
        path = candidate.resolve(strict=True)
        info = path.stat()
        source.require(path.is_file() and info.st_uid in (0, deployment_config.load().get('nodeSourceUid'))
                       and not info.st_mode & 0o022, 'unsafe installed Node executable')
        source.require(re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)), 'unsupported Node path')
        version = run(str(path), '--version')
        source.require(re.fullmatch(r'v24\.[0-9]+\.[0-9]+', version), 'installed Node 24 required')
        return path, version
    raise RuntimeError('installed Node 24 not found; no staging performed')


def seal_node(path, version):
    """Keep a root-owned private-runtime copy; never change the installed binary."""
    before = path.stat()
    source.require(before.st_size < 256 * 1024 * 1024, 'Node executable over bound')
    data = path.read_bytes(); after = path.stat()
    identity = lambda s: (s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    source.require(identity(before) == identity(after), 'installed Node changed during copy')
    directory(BASE / 'bin')
    target = BASE / 'bin/node'
    write(target, data, 0o755)
    source.require(run(str(target), '--version') == version, 'sealed Node version mismatch')
    return target, {'source': str(path), 'sourceUid': before.st_uid, 'version': version,
                    'path': str(target), 'sha256': hashlib.sha256(data).hexdigest()}


def prekey_staging():
    """Specific observed ENOENT stop, before key generation; no economic resume."""
    for path in (BASE, BASE / 'releases', BASE / 'manifests', BASE / 'acme'):
        source.require(path.is_dir() and not path.is_symlink(), 'unsafe pre-key scaffold')
    source.require({p.name for p in BASE.iterdir()} == {'releases', 'manifests', 'acme'}, 'unexpected pre-key scaffold')
    source.require(not any((BASE / 'acme').iterdir()), 'unexpected ingress files')
    source.require({p.name for p in (BASE / 'releases').iterdir()} == {PREKEY_SOURCE}, 'unexpected staged releases')
    manifests = BASE / 'manifests'
    marker = manifests / 'prekey-stop.json'
    source.require(marker.is_file() and not marker.is_symlink(), 'specific pre-key stop missing')
    stop = json.loads(marker.read_text())
    source.require(stop.get('schema') == 1 and stop.get('source') == PREKEY_SOURCE
        and stop.get('reason') == 'NODE_EXECUTABLE_ABSENT_BEFORE_KEY_GENERATION', 'wrong pre-key stop')
    expected = {'before.json', 'approval.json', 'before-' + PREKEY_SOURCE + '.json',
                'approval-' + PREKEY_SOURCE + '.json', PREKEY_SOURCE + '.json'}
    source.require(set(stop['manifests']) == expected and
                   {p.name for p in manifests.iterdir()} == expected | {'prekey-stop.json'}, 'pre-key manifests changed')
    for name, digest in stop['manifests'].items():
        path = manifests / name
        source.require(path.is_file() and not path.is_symlink()
            and hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'original pre-key manifest changed')
    for root in (PRIVATE, STATE):
        source.require(root.is_dir() and not root.is_symlink()
                       and {p.name for p in root.iterdir()} == {'facilitator', 'resource'}, 'unexpected role roots')
        for role in ('facilitator', 'resource'):
            path = root / role
            source.require(path.is_dir() and not path.is_symlink() and not any(path.iterdir()),
                           'key/state/lock exists; pre-key continuation denied')
    for name in USERS:
        user = pwd.getpwnam(name)
        source.require(stop['users'].get(name) == {'uid': user.pw_uid, 'gid': user.pw_gid}
            and user.pw_shell in ('/usr/sbin/nologin', '/sbin/nologin')
            and not Path('/etc/systemd/system/' + name + '.service').exists(), 'pre-key runtime identity changed')


def snapshot():
    files = {}
    for root in OLD_STATE:
        for directory, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = sorted(n for n in dirs if n != 'node_modules' and not (Path(directory) / n).is_symlink())
            for name in sorted(names):
                p = Path(directory) / name
                if not p.is_file() or p.is_symlink():
                    continue
                before = p.stat()
                source.require(before.st_size <= 8 * 1024 * 1024 and len(files) < 10000, 'state inventory bound exceeded')
                data = p.read_bytes()
                after = p.stat()
                source.require((before.st_ino, before.st_size, before.st_mtime_ns) ==
                               (after.st_ino, after.st_size, after.st_mtime_ns), 'old state changed during observation')
                files[str(p)] = hashlib.sha256(data).hexdigest()
    processes = {name: run('systemctl', 'show', '-p', 'MainPID,InvocationID,ActiveState,WorkingDirectory', name)
                 for name in OLD_SERVICES}
    return {'files': files, 'processes': processes}


def no_pending():
    for root in ('/opt/capture402', '/opt/capture402-dev', '/opt/capture402-e2e'):
        source.require(not any((Path(root) / name).exists() for name in ('transaction.json', 'pending.json')),
                       'existing deployment pending; no recovery authorized by this installer')


def rpc(endpoint, method, params):
    url = urllib.parse.urlsplit(endpoint)
    source.require(url.scheme == 'https' and not url.username and not url.password and not url.fragment
                   and (url.hostname or '').endswith(('.quiknode.pro', '.helius-rpc.com')), 'explicit private provider required')
    request = urllib.request.Request(endpoint, data=json.dumps({'jsonrpc': '2.0', 'id': 1,
        'method': method, 'params': params}).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(cli.NoRedirect()).open(request, timeout=20) as response:
            data = json.loads(response.read(2 * 1024 * 1024))
        source.require('error' not in data and 'result' in data, 'RPC result unavailable')
        return data['result']
    except Exception:
        raise RuntimeError('configured-provider observation unavailable; no fallback') from None


def program_preflight(endpoint):
    source.require(rpc(endpoint, 'getGenesisHash', []) == GENESIS, 'wrong Devnet genesis')
    slot = rpc(endpoint, 'getSlot', [{'commitment': 'finalized'}])
    result = rpc(endpoint, 'getMultipleAccounts', [[PROGRAM, PROGRAM_DATA, MINT],
        {'commitment': 'finalized', 'encoding': 'base64', 'minContextSlot': slot}])
    program, program_data, mint = result['value']
    loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
    source.require(program and program_data and program['executable']
                   and program['owner'] == program_data['owner'] == loader, 'wrong Program identity')
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    number = 0
    for char in PROGRAM_DATA:
        number = number * 58 + alphabet.index(char)
    pointer = number.to_bytes(32, 'big')
    p = base64.b64decode(program['data'][0]); d = base64.b64decode(program_data['data'][0])
    source.require(p[:4] == (2).to_bytes(4, 'little') and p[4:36] == pointer
                   and d[:4] == (3).to_bytes(4, 'little')
                   and len(d[45:]) == deployment_config.positive_integer('acceptedExecutableSizeBytes', 10485760) and hashlib.sha256(d[45:]).hexdigest() == SBF, 'accepted SBF mismatch')
    source.require(mint and mint['owner'] == 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'wrong classic SPL mint')
    mint_data = base64.b64decode(mint['data'][0])
    source.require(len(mint_data) == 82 and mint_data[44:46] == bytes([6, 1]), 'mint must be initialized with six decimals')
    return {'contextSlot': result['context']['slot'], 'minContextSlot': slot, 'genesis': GENESIS,
            'program': PROGRAM, 'programData': PROGRAM_DATA, 'sbfSha256': SBF, 'mint': MINT}


def unit(name, release, entry, env_file, state, node):
    return f'''[Unit]
Description=Capture402 isolated paid-resource {name}
After=network-online.target
Wants=network-online.target
[Service]
Type=exec
Slice=capture402-paid.slice
User={name}
Group={name}
WorkingDirectory={release}/integration
EnvironmentFile={env_file}
ExecStart={node} --experimental-strip-types src/{entry}
Restart=no
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths={state}
InaccessiblePaths=/etc/sac006 /var/lib/sac006 /etc/capture402-dev /var/lib/capture402-dev /etc/capture402-e2e /var/lib/capture402-e2e
MemoryMax=512M
CPUQuota=50%
TasksMax=64
LimitFSIZE=16777216
'''


def ingress(operator_ip, tls=False):
    ip = ipaddress.ip_address(operator_ip)
    source.require(ip.is_global, 'public operator address required')
    challenge = f'location ^~ /.well-known/acme-challenge/ {{ root {BASE}/acme; }}'
    if not tls:
        return f'server {{ listen 80; server_name {DOMAIN}; {challenge} location / {{ return 404; }} }}\n'
    return f'''limit_req_zone $binary_remote_addr zone=capture402_paid:1m rate=2r/s;
server {{ listen 80; server_name {DOMAIN}; {challenge} location / {{ return 301 {ORIGIN}$request_uri; }} }}
server {{
 listen 443 ssl; server_name {DOMAIN};
 ssl_certificate /etc/letsencrypt/live/{DOMAIN}/fullchain.pem;
 ssl_certificate_key /etc/letsencrypt/live/{DOMAIN}/privkey.pem;
 allow {ip}; allow 127.0.0.1; deny all;
 client_max_body_size 32k;
 access_log /var/log/nginx/capture402-paid.access.log;
 error_log /var/log/nginx/capture402-paid.error.log;
 location / {{
  limit_req zone=capture402_paid burst=8 nodelay;
  proxy_pass http://127.0.0.1:38888;
  proxy_set_header Host {DOMAIN};
  proxy_set_header X-Forwarded-Proto https;
  proxy_read_timeout 15s;
 }}
}}
'''


def environments(endpoint, record, identities, bearer):
    common = {'SOLANA_RPC_URL': endpoint, 'SAC006_DEPLOYMENT_RECORD_PATH': str(record),
              'SAC006_BEARER_TOKEN': bearer, 'SAC006_HOST': '127.0.0.1'}
    facilitator = common | {'SAC006_PORT': '38887', 'SAC006_SPONSOR_MAX_ATTEMPTS': '0',
        'SAC006_SPONSOR_MIN_LAMPORTS': '10000000', 'SAC006_ALLOWLIST_MERCHANT': identities['resource'],
        'SAC006_ALLOWLIST_MINT': MINT, 'SAC006_FACILITATOR_KEYPAIR_PATH': str(PRIVATE / 'facilitator/key.json'),
        'SAC006_FACILITATOR_JOURNAL_DIR': str(STATE / 'facilitator/journal')}
    resource = common | {'SAC006_RESOURCE_PORT': '38888', 'SAC006_FACILITATOR_URL': 'http://127.0.0.1:38887',
        'SAC006_FEE_PAYER': identities['facilitator'], 'SAC006_ASSET_MINT': MINT,
        'SAC006_AUTHORIZE_AMOUNT': '100000000', 'SAC006_PAID_REPORT_ENABLED': 'true',
        'SAC006_PUBLIC_ORIGIN': ORIGIN, 'SAC006_SERVER_KEYPAIR_PATH': str(PRIVATE / 'resource/key.json'),
        'SAC006_STORE_DIR': str(STATE / 'resource/operations')}
    return facilitator, resource


def rollback():
    # Fixed new service names only; never invoke a generic recovery command.
    try:
        if ENABLED.is_symlink() and os.readlink(ENABLED) == str(NGINX):
            ENABLED.unlink()
            run('nginx', '-t'); run('systemctl', 'reload', 'nginx')
    finally:
        run('systemctl', 'stop', *[name + '.service' for name in reversed(USERS)])


def start_runtime():
    # Type=exec acknowledges execve, not HTTP readiness. The resource checks the
    # facilitator once during startup, so its dependency must already be ready.
    for name, port, route, expected in ((USERS[0], 38887, '/supported', 200),
                                        (USERS[1], 38888, '/resource', 402)):
        run('systemctl', 'start', name)
        for attempt in range(20):
            try:
                status, body, headers = source.response(f'http://127.0.0.1:{port}{route}')
                if status == expected:
                    break
            except OSError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError('new runtime readiness failed')


def install(sha, operator_ip, resume_staging=False, resume_prekey=False):
    source.require(os.geteuid() == 0 and source.SHA_RE.fullmatch(sha), 'authorized sudo and exact SHA required')
    source.require_private_namespace()
    deployment_config.origin('paidOrigin')
    for name in ['acceptedExecutableSha256','paidPrekeySource']:
        deployment_config.digest(name,40 if name=='paidPrekeySource' else 64)
    for name in ['paidMint','programId','programData']:deployment_config.text(name)
    installed_node, node_version = node_source()
    source.require(Path(__file__).resolve().parent == Path('/opt/capture402/controllers') / sha,
                   'installer must be retained beside the exact installed controller')
    no_pending()
    source.require(not any(p.exists() or p.is_symlink() for p in (NGINX, ENABLED)), 'paid ingress already exists')
    source.require(not (resume_staging and resume_prekey), 'select one observed staging continuation')
    if resume_prekey:
        prekey_staging()
    elif resume_staging:
        empty_staging()
    else:
        source.require(not any(p.exists() or p.is_symlink() for p in (BASE, PRIVATE, STATE)),
                       'paid namespace already exists; inspect original receipt before any continuation')
    for name in USERS:
        if resume_prekey:
            continue  # Exact existing UID/GID, empty keys/state and absent units checked above.
        try:
            pwd.getpwnam(name)
        except KeyError:
            continue
        raise RuntimeError('paid runtime user already exists; inspect before continuation')
    ingress(operator_ip)  # Validate restriction before creating users/files or starting services.
    for port in (38887, 38888):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', port))
    api = cli.GitHub()
    acceptance = policy.verify(sha, api)
    endpoint = host.env_value(RPC_CONFIG, 'SOLANA_RPC_URL')
    observation = program_preflight(endpoint)
    before = snapshot()
    for path in (BASE, PRIVATE, STATE):
        directory(path)
    for name in ('releases', 'manifests', 'acme'):
        directory(BASE / name)
    before_path = BASE / 'manifests' / ('before-' + sha + '.json')
    approval_path = BASE / 'manifests' / ('approval-' + sha + '.json')
    source.require(not before_path.exists() and not approval_path.exists(), 'same-source staging already recorded')
    source.write_json(before_path, before)
    source.write_json(approval_path, acceptance)
    node, node_identity = seal_node(installed_node, node_version)
    # Reuse the bounded private-only archive/build path with disjoint release roots.
    old_releases, old_manifests = source.RELEASES, source.MANIFESTS
    try:
        source.RELEASES, source.MANIFESTS = BASE / 'releases', BASE / 'manifests'
        blob = source.manually_fetch_archive(sha)
        source.verify_source_against_main(sha, blob)
        source.prepare_release(sha, hashlib.sha256(blob).hexdigest(), blob)
    finally:
        source.RELEASES, source.MANIFESTS = old_releases, old_manifests
    release = BASE / 'releases' / sha
    source.require(hashlib.sha256((release / source.RECORD).read_bytes()).hexdigest() ==
        deployment_config.digest('deploymentRecordSha256'), 'accepted deployment record changed')
    for role, name in zip(('facilitator', 'resource'), USERS):
        if not resume_prekey:
            run('useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', name)
        user = pwd.getpwnam(name)
        directory(PRIVATE / role, 0o750); os.chown(PRIVATE / role, 0, user.pw_gid)
        directory(STATE / role, 0o700); os.chown(STATE / role, user.pw_uid, user.pw_gid)
    # Key generation performs no signing or RPC. Only public addresses leave Node.
    script = '''import { generateKeyPairSigner } from '@solana/kit';
import { writeFileSync } from 'node:fs';
const output={};
for(const role of ['facilitator','resource']) {
 const s=await generateKeyPairSigner(true);
 const secret=new Uint8Array(await crypto.subtle.exportKey('pkcs8',s.keyPair.privateKey));
 const pub=new Uint8Array(await crypto.subtle.exportKey('raw',s.keyPair.publicKey));
 writeFileSync('/etc/capture402-paid/'+role+'/key.json',JSON.stringify([...secret.slice(-32),...pub]),{mode:0o600,flag:'wx'});
 output[role]=s.address;
}
console.log(JSON.stringify(output));'''
    identities = json.loads(run(str(node), '--input-type=module', '-e', script, cwd=release / 'integration'))
    source.require(identities['facilitator'] != identities['resource'], 'signer separation failed')
    balance = rpc(endpoint, 'getBalance', [identities['facilitator'], {'commitment': 'finalized'}])
    source.require(balance['value'] == 0, 'initial paid sponsor must be unfunded')
    configs = environments(endpoint, release / source.RECORD, identities, secrets.token_urlsafe(48))
    for role, name, entry, config in zip(('facilitator', 'resource'), USERS,
            ('devnet-server.ts', 'devnet-resource-server.ts'), configs):
        user = pwd.getpwnam(name)
        os.chown(PRIVATE / role / 'key.json', user.pw_uid, user.pw_gid)
        env_file = PRIVATE / role / 'runtime.env'
        # systemd EnvironmentFile values are quoted; reject line/control injection.
        source.require(all(not any(c in value for c in '\r\n\x00') for value in config.values()), 'invalid environment value')
        write(env_file, ''.join(k + '=' + json.dumps(v) + '\n' for k, v in config.items()))
        write(Path('/etc/systemd/system') / (name + '.service'),
              unit(name, release, entry, env_file, STATE / role, node), 0o644)
    no_pending()
    # Point only the existing offline gate/recovery executables at the fixed code.
    for unit_name in ('capture402-gate.service', 'capture402-recovery.service'):
        path = Path('/etc/systemd/system') / unit_name
        source.require(path.is_file() and not path.is_symlink(), 'unsafe existing recovery unit')
        original = path.read_text()
        updated, count = re.subn(r'/opt/capture402/controllers/[0-9a-f]{40}/deploy_vps\.py',
            '/opt/capture402/controllers/' + sha + '/deploy_vps.py', original)
        source.require(count == 1, 'unknown existing recovery target')
        write(BASE / 'manifests' / (unit_name + '.before'), original)
        host.atomic_bytes(path, updated.encode(), 0o644)
    run('systemd-analyze', 'verify', *[str(Path('/etc/systemd/system') / (n + '.service')) for n in USERS])
    run('systemctl', 'daemon-reload')
    source.require_private_recovery_namespace()
    policy.verify(sha, cli.GitHub())  # A build can outlive the first API client's bounded deadline.
    observation = program_preflight(endpoint)
    source.require(snapshot() == before, 'old application/state drift before activation')
    phase = 'service-start'
    try:
        start_runtime()
        phase = 'certificate'
        write(NGINX, ingress(operator_ip), 0o644); ENABLED.symlink_to(NGINX)
        run('nginx', '-t'); run('systemctl', 'reload', 'nginx')
        run('certbot', 'certonly', '--webroot', '-w', str(BASE / 'acme'), '-d', DOMAIN,
            '--non-interactive', '--agree-tos')
        phase = 'https'
        host.atomic_bytes(NGINX, ingress(operator_ip, tls=True).encode(), 0o644)
        run('nginx', '-t'); run('systemctl', 'reload', 'nginx')
        after = snapshot()
        source.require(after == before, 'old application/state drift during activation')
        receipt = {'sha': sha, 'verdict': 'DEPLOYED_ZERO_SUBMISSIONS', 'origin': ORIGIN,
                   'node': node_identity,
                   'program': observation, 'identities': identities, 'sponsorLamports': 0,
                   'maxSponsorAttempts': 0, 'oldProcessesAndStateUnchanged': True,
                   'operatorIp': operator_ip, 'before': before, 'after': after,
                   'autoRestart': False, 'autoBoot': False, 'fundedAcceptance': 'NOT RUN'}
        source.write_json(BASE / 'deployment-receipt.json', receipt)
        print(json.dumps({k: v for k, v in receipt.items() if k not in ('before', 'after', 'operatorIp')}))
    except BaseException:
        with contextlib.suppress(Exception):
            source.write_json(BASE / 'failure.json', {'sha': sha, 'phase': phase, 'outcome': 'STOP_REQUIRED_NO_REPLAY'})
        rollback()
        raise RuntimeError('paid installation stopped; preserve original receipt and state') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'stop'))
    parser.add_argument('--sha'); parser.add_argument('--operator-ip')
    parser.add_argument('--resume-empty-staging', action='store_true',
                        help='only the exact empty pre-build scaffold; retain its original manifests')
    parser.add_argument('--resume-prekey-staging', action='store_true',
                        help='only the retained specific missing-Node stop before key generation')
    args = parser.parse_args()
    source.require(os.geteuid() == 0, 'authorized sudo required')
    source.require_private_namespace()
    fd = os.open('/run/capture402-paid-install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'stop':
            rollback()
        else:
            source.require(bool(args.sha and args.operator_ip), 'exact SHA and operator IP required')
            install(args.sha, args.operator_ip, args.resume_empty_staging, args.resume_prekey_staging)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('PAID_INSTALL_BLOCKED: inspect private retained receipt; no automatic retry', file=__import__('sys').stderr)
        raise SystemExit(1)
