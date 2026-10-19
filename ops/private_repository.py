#!/usr/bin/env python3
"""Guarded public upstream Git and Issue/PR entrypoints; no identity fallback."""
import argparse
import json
import os
import re
import subprocess
import sys

REPOSITORY = 'starPaw/capture402-solana'
import deployment_config
REPOSITORY_ID = None  # Assigned by GitHub later; trusted installation policy is mandatory.
SOURCE_URLS = {
    'https://github.com/starPaw/capture402-solana.git',
    'git@github.com:starPaw/capture402-solana.git',
    'ssh://git@github.com/starPaw/capture402-solana.git',
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def output(*command, env=None):
    try:
        return subprocess.check_output(command, env=env, stderr=subprocess.DEVNULL,
                                       text=True, timeout=30).strip()
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError('Source repository check unavailable; stop before network effects') from None


def local_identity():
    # get-url expands insteadOf/pushInsteadOf without contacting any remote.
    for direction in ([], ['--push']):
        urls = output('git', 'remote', 'get-url', *direction, '--all', 'origin').splitlines()
        require(len(urls) == 1 and urls[0] in SOURCE_URLS,
                'SOURCE-IDENTITY: origin identity is absent, ambiguous or not approved; no network request made')


def github_environment():
    return dict(os.environ, GH_HOST='github.com', GH_REPO=REPOSITORY)


def github_identity(env):
    repository_id = deployment_config.require_repository()
    # Numeric endpoint avoids looking up a reused/renamed namespace.
    try:
        item = json.loads(output('gh', 'api', '--hostname', 'github.com',
                                 f'repositories/{repository_id}', env=env))
    except ValueError:
        raise RuntimeError('Source GitHub identity response invalid') from None
    require(isinstance(item, dict) and type(item.get('id')) is int
            and item['id'] == repository_id and item.get('full_name') == REPOSITORY
            and item.get('private') is False,
            'SOURCE-IDENTITY: public GitHub ID/name/visibility mismatch; operation denied')


def operation(args):
    repository_id = deployment_config.require_repository()
    # Validate the requested operation locally before any GitHub request.
    if args.command == 'api':
        require(bool(re.fullmatch(r'(issues|pulls)(/[A-Za-z0-9_-]+)*', args.route)),
                'SOURCE-IDENTITY: only relative source Issue/PR routes are supported')
        require(args.route.split('/')[-1] != 'merge',
                'Merge requires a separate owner-authorized workflow')
    branch = None
    if args.command == 'push':
        branch = output('git', 'symbolic-ref', '--quiet', '--short', 'HEAD')
        require(branch.startswith('codex/'), 'Guarded push requires a current codex/* task branch')
        output('git', 'check-ref-format', 'refs/heads/' + branch)
    local_identity()
    env = github_environment()
    if args.command != 'check' or args.github:
        github_identity(env)
    if args.command == 'check':
        print('Source repository identity verified' if args.github else 'Source origin fetch/push URLs verified locally')
        return 0
    if args.command == 'fetch':
        command = ['git', '-c', 'http.followRedirects=false', 'fetch', 'origin']
    elif args.command == 'push':
        command = ['git', '-c', 'http.followRedirects=false', '-c', 'remote.origin.mirror=false',
                   'push', '--set-upstream', '--no-follow-tags',
                   'origin', f'HEAD:refs/heads/{branch}']
    else:
        command = ['gh', 'api', '--hostname', 'github.com', '--method', args.method,
                   f'repositories/{repository_id}/{args.route}']
        if args.input:
            command += ['--input', args.input]
    return subprocess.call(command, env=env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('check')
    check.add_argument('--github', action='store_true')
    commands.add_parser('fetch')
    commands.add_parser('push')
    api = commands.add_parser('api')
    api.add_argument('route')
    api.add_argument('--method', choices=['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], default='GET')
    api.add_argument('--input')
    try:
        return operation(parser.parse_args())
    except (RuntimeError, OSError) as error:
        print('Source repository operation refused; inspect trusted identity and requested scope', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
