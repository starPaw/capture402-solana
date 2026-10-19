#!/usr/bin/env python3
"""Reject personal macOS paths in tracked/indexed files without echoing them."""
import argparse
import gzip
import hashlib
import io
from pathlib import Path
import re
import subprocess
import tarfile
from urllib.parse import unquote_to_bytes


LOCAL_PATH = re.compile(rb'/(?:Users|Volumes|private/(?:tmp|var)|var/folders)/')


def has_local_path(data):
    normalized = unquote_to_bytes(data.replace(b'\\/', b'/'))
    return bool(LOCAL_PATH.search(normalized))


def violations(name, data):
    errors = []
    if has_local_path(name.encode()) or has_local_path(data):
        errors.append('file bytes or name')
    if data.startswith(b'\x1f\x8b'):
        try:
            expanded = gzip.decompress(data)
            if has_local_path(expanded):
                errors.append('gzip contents')
            # Inspect metadata and members without extracting to disk.
            if tarfile.is_tarfile(io.BytesIO(expanded)):
                with tarfile.open(fileobj=io.BytesIO(expanded)) as archive:
                    for member in archive:
                        if has_local_path(member.name.encode()) or has_local_path(member.linkname.encode()):
                            errors.append('archive member metadata')
                        if member.isfile():
                            errors.extend('archive member ' + error for error in
                                          violations('archive-member', archive.extractfile(member).read()))
        except (OSError, EOFError, tarfile.TarError):
            errors.append('unreadable compressed file')
    return errors


def indexed_files(root):
    entries = subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=root).split(b'\0')
    files = []
    for entry in filter(None, entries):
        metadata, name = entry.split(b'\t', 1)
        mode, oid, stage = metadata.split()
        if stage != b'0':
            raise RuntimeError('Resolve unmerged index entries before checking paths')
        if mode == b'160000':
            raise RuntimeError('Submodules require a separate local-path scan')
        files.append((name.decode(), oid))
    output = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=root,
                                    input=b'\n'.join(oid for _, oid in files) + b'\n')
    stream = io.BytesIO(output)
    for name, _ in files:
        _, kind, size = stream.readline().split()
        if kind != b'blob':
            raise RuntimeError('Expected an indexed file blob')
        data = stream.read(int(size))
        if stream.read(1) != b'\n':
            raise RuntimeError('Invalid Git blob framing')
        yield name, data


def check(root, staged=False):
    if staged:
        files = indexed_files(root)
    else:
        names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).split(b'\0')
        files = ((name.decode(), (root / name.decode()).read_bytes()) for name in names if name)
    errors, count = [], 0
    for name, data in files:
        count += 1
        for error in violations(name, data):
            # Never print the matched private path or source line.
            label = '<redacted filename>' if has_local_path(name.encode()) else name
            errors.append(f'{label}: {error} contains a local path or cannot be inspected')
    return errors, count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true', help='scan actual Git index bytes')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    errors, count = check(root, args.staged)
    for error in errors:
        print(error)
    print(f'{count} tracked files checked; {len(errors)} local-path violations')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
