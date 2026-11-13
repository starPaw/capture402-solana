#!/usr/bin/env bash
# Run only in a marked disposable VM. No deployment, installed policy or live RPC.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]
[[ "${CAPTURE402_E2E_DISPOSABLE:-}" == 1 ]]
: "${CAPTURE402_LINUX_TEST_USER:?Set the non-root fixture user}"
[[ "$(id -u "$CAPTURE402_LINUX_TEST_USER")" != 0 ]]
python3 - <<'PY'
from pathlib import Path
import stat
p = Path('/etc/capture402-e2e-disposable')
s = p.lstat()
assert stat.S_ISREG(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022
assert p.read_text().strip() == 'DISPOSABLE_SYNTHETIC_E2E_TEST_ONLY'
assert Path('/proc/1/comm').read_text().strip() == 'systemd'
PY
[[ "$(node --version)" == "v$(cat .nvmrc)" ]]
nginx_bin="$(command -v nginx)"
strace_bin="$(command -v strace)"
test -s target/deploy/svm_auth_capture.so
evidence="$(mktemp -d /var/tmp/capture402-linux-evidence.XXXXXXXX)"
temporary="$(mktemp -d /var/tmp/capture402-linux-tmp.XXXXXXXX)"
chown "$CAPTURE402_LINUX_TEST_USER" "$evidence" "$temporary"
# Debian can mount /tmp as tmpfs. Never relax the permanent journal's disk guard.
node -e 'const {statfsSync}=require("node:fs");require("node:assert/strict")([0xef53n,0x58465342n,0x9123683en].includes(statfsSync(process.argv[1],{bigint:true}).type))' "$temporary"
printf 'Linux evidence: %s\n' "$evidence"
{
  uname -srm
  node --version
  npm --version
  "$nginx_bin" -v
  "$strace_bin" --version | head -n 1
  systemctl --version | head -n 1
  sha256sum target/deploy/svm_auth_capture.so
} > "$evidence/environment.txt" 2>&1
runuser -u "$CAPTURE402_LINUX_TEST_USER" -- npm run --prefix integration typecheck
runuser -u "$CAPTURE402_LINUX_TEST_USER" -- env TMPDIR="$temporary" NO_COLOR=1 \
  SAC006_TEST_NGINX="$nginx_bin" SAC006_TEST_STRACE="$strace_bin" SAC006_TEST_NGINX_ISOLATED_PORTS=1 \
  npm run --prefix integration test -- --maxWorkers=2 --reporter=dot --reporter=json --outputFile="$evidence/integration.json"
python3 - "$evidence/integration.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['success'] and d['numFailedTests'] == 0
assert d['numPendingTests'] == 0 and d.get('numTodoTests', 0) == 0, 'Linux checks must not skip'
print(json.dumps({'integrationPassed': d['numPassedTests'], 'skipped': d['numPendingTests']}))
PY
CAPTURE402_SYSTEMD_TEST=1 python3 -B - <<'PY'
import json, sys, unittest
sys.path.insert(0, 'ops')
result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.discover('ops', pattern='test_*.py'))
print(json.dumps({'operatorTests': result.testsRun, 'skipped': len(result.skipped), 'successful': result.wasSuccessful()}))
raise SystemExit(0 if result.wasSuccessful() and not result.skipped else 1)
PY
