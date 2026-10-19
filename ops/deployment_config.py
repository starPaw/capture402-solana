"""Trusted installation data, external to the public source and its Git history.

No caller-controlled path, environment override, or permissive live fallback exists.
Tests patch the loader with synthetic in-memory data; production reads only this file.
"""
import json
import os
from pathlib import Path
import re
import stat

POLICY_PATH = Path('/etc/capture402/operational-data.json')
REPOSITORY = 'starPaw/capture402-solana'


def load():
    path = POLICY_PATH
    try:
        before = {}
        for item in [*reversed(path.parents), path]:
            meta = item.lstat()
            if stat.S_ISLNK(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
                raise ValueError('untrusted policy metadata')
            if item != path and not stat.S_ISDIR(meta.st_mode):
                raise ValueError('untrusted policy ancestry')
            before[item] = (meta.st_dev, meta.st_ino, meta.st_mode, meta.st_uid, meta.st_nlink)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            first = os.fstat(fd)
            if (not stat.S_ISREG(first.st_mode) or first.st_nlink != 1 or first.st_size > 131072
                    or first.st_uid != 0 or first.st_mode & 0o022
                    or before[path] != (first.st_dev, first.st_ino, first.st_mode, first.st_uid, first.st_nlink)):
                raise ValueError('untrusted policy file')
            data = os.read(fd, 131073)
            after = os.fstat(fd)
            if (first.st_dev, first.st_ino, first.st_size, first.st_mtime_ns, first.st_ctime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('policy changed during read')
        finally:
            os.close(fd)
        for item, expected in before.items():
            meta = item.lstat()
            if expected != (meta.st_dev, meta.st_ino, meta.st_mode, meta.st_uid, meta.st_nlink):
                raise ValueError('policy ancestry changed')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('duplicate policy field')
                result[key] = value
            return result
        value = json.loads(data, object_pairs_hook=unique)
        if not isinstance(value, dict) or type(value.get('schema')) is not int or value['schema'] != 1:
            raise ValueError('invalid operational policy')
        return value
    except (OSError, ValueError, TypeError):
        raise RuntimeError('Trusted installation policy unavailable; operation denied') from None


def optional(name, fallback=''):
    """Offline import sentinel only; live entrypoints call require_repository first."""
    try:
        value = load().get(name, fallback)
        return value if isinstance(value, str) else fallback
    except RuntimeError:
        return fallback


def text(name):
    value = load().get(name)
    if not isinstance(value, str) or not value.strip() or any(c in value for c in '\r\n\x00'):
        raise RuntimeError('Trusted installation field unavailable: ' + name)
    return value


def digest(name, length=64):
    value = text(name)
    if not re.fullmatch('[0-9a-f]{' + str(length) + '}', value):
        raise RuntimeError('Invalid trusted digest: ' + name)
    return value


def require_repository():
    value = load()
    identifier = value.get('repositoryId')
    if (type(identifier) is not int or identifier <= 0 or value.get('repository') != REPOSITORY
            or value.get('repositoryPrivate') is not False):
        raise RuntimeError('Repository identity unavailable; assignment and trusted policy required')
    return identifier


def origin(name):
    from urllib.parse import urlsplit
    value = text(name)
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.hostname.endswith('.invalid')
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise RuntimeError('Invalid trusted HTTPS origin: ' + name)
    return value


def read_record():
    """Read the fixed deployment record with the same filesystem trust boundary."""
    path = Path('/etc/capture402/deployment-identity.v1.json')
    before = {}
    try:
        for item in [*reversed(path.parents), path]:
            meta = item.lstat()
            if stat.S_ISLNK(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
                raise ValueError('untrusted deployment record')
            before[item] = (meta.st_dev, meta.st_ino, meta.st_mode, meta.st_uid, meta.st_nlink)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            first = os.fstat(fd)
            if not stat.S_ISREG(first.st_mode) or first.st_nlink != 1 or first.st_size > 1048576:
                raise ValueError('invalid deployment record')
            if before[path] != (first.st_dev, first.st_ino, first.st_mode, first.st_uid, first.st_nlink):
                raise ValueError('record changed before open')
            data = os.read(fd, 1048577)
            after = os.fstat(fd)
            if (first.st_size, first.st_mtime_ns, first.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('record changed during read')
        finally:
            os.close(fd)
        for item, expected in before.items():
            meta = item.lstat()
            if expected != (meta.st_dev, meta.st_ino, meta.st_mode, meta.st_uid, meta.st_nlink):
                raise ValueError('record ancestry changed')
        return data
    except (OSError, ValueError):
        raise RuntimeError('Trusted deployment record unavailable; operation denied') from None


def positive_integer(name, maximum):
    value = load().get(name)
    if type(value) is not int or not 0 < value <= maximum:
        raise RuntimeError('Invalid trusted bounded integer: ' + name)
    return value
