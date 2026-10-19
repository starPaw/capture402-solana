#!/usr/bin/env bash
# Explicit development-host setup. Never reuses another user's credentials.
set -euo pipefail
umask 077
[[ $# == 2 ]] || { printf 'Usage: provision.sh <development-user> <reviewed-absolute-checkout>\n' >&2; exit 2; }
dev_user=$1
repo=$2
[[ $dev_user =~ ^[a-z][a-z0-9-]{0,30}$ && $repo == /* && $repo != / && $repo != *$'\n'* ]] || exit 2
getent passwd "$dev_user" >/dev/null || sudo useradd --create-home --shell /bin/bash "$dev_user"
dev_home=$(getent passwd "$dev_user" | cut -d: -f6)
[[ -d $repo && ! -L $repo && -f $repo/integration/package.json ]] || exit 2
sudo chmod 0700 "$dev_home"
sudo install -d -m 0700 -o "$dev_user" -g "$dev_user" "$dev_home/.ssh"
# Authentication and repository-scoped read credentials are enrolled separately.
# Do not copy SSH authorization, provider keys or application login files.
printf 'Development account prepared. Enroll credentials separately and review checkout ownership.\n'
