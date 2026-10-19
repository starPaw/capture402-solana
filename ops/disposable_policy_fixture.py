"""Synthetic installation data for explicitly marked disposable Linux hosts only."""
import hashlib
import json
import os
from pathlib import Path
import socket


def install(snapshot, **fields):
    marker = Path('/etc/capture402-p2-disposable')
    if (os.geteuid() != 0 or socket.gethostname() != 'capture402-p2-disposable'
            or marker.read_text().strip() != 'DISPOSABLE_SYNTHETIC_P2_TEST_ONLY'):
        raise RuntimeError('Synthetic policy requires the marked disposable host')
    directory = Path('/etc/capture402')
    directory.mkdir(mode=0o755, exist_ok=True)
    path = directory / 'operational-data.json'
    if path.is_symlink() or path.exists() and json.loads(path.read_text()).get('disposableSyntheticOnly') is not True:
        raise RuntimeError('Existing installation policy is not a disposable fixture')
    value = {'schema': 1, 'repository': 'starPaw/capture402-solana', 'repositoryId': 123456789,
        'repositoryPrivate': False, 'disposableSyntheticOnly': True,
        'nodeBinarySha256': hashlib.sha256((Path(snapshot) / 'node/bin/node').read_bytes()).hexdigest(),
        'providerHost': 'synthetic.helius-rpc.com',
        'signerCustody': {'sponsor': {'uid': 989, 'gid': 986}, 'mint': {'uid': 0, 'gid': 0}}}
    value.update(fields)
    # This is labeled public synthetic test data, not a template for live secrets.
    with path.open('w') as output:
        json.dump(value, output); output.flush(); os.fsync(output.fileno())
    path.chmod(0o644)
