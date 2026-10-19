#!/usr/bin/env bash
# Invoke only from a reviewed sealed snapshot after external wrapper/verifier digest checks.
set -euo pipefail
[[ $# == 3 && $2 == --profile && $3 == e2e && $(id -u) == 0 ]] || exit 64
case "$1" in quote|issue|observe) ;; *) exit 64 ;; esac
snapshot=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
/usr/bin/python3 -I -B "$snapshot/ops/faucet-stock-verify.py" "$snapshot" "$1"
mapfile -t custody < <(/usr/bin/python3 -I -B -c 'import sys; sys.path.insert(0,sys.argv[1]); import deployment_config; c=deployment_config.load()["signerCustody"]["sponsor"]; assert type(c["uid"]) is int and type(c["gid"]) is int and c["uid"]>=0 and c["gid"]>=0; print(c["uid"]); print(c["gid"])' "$snapshot/ops")
[[ ${#custody[@]} == 2 ]] || exit 78
mapfile -t rpc_ips < <(/usr/bin/python3 -I -B -c 'import json; print("\n".join(json.load(open("/etc/capture402-e2e/p2-network.json"))["addresses"]))')
[[ ${#rpc_ips[@]} -gt 0 ]] || exit 78
unit="capture402-e2e-stock-$(cat /proc/sys/kernel/random/uuid)"
credentials=(--property=LoadCredential=stock-approval:/etc/capture402-e2e/faucet-stock-approved.json --property=LoadCredential=stock-hosts:/etc/capture402-e2e/p2-hosts)
if [[ $1 == issue ]];then
 credentials+=(--property=LoadCredential=sponsor-key:/etc/capture402-e2e/keys/sponsor.json --property=LoadCredential=mint-key:/etc/capture402-e2e/keys/mint.json)
fi
exec /usr/bin/systemd-run --quiet --wait --pipe --collect --unit="$unit" \
 --property=Type=exec --property="User=${custody[0]}" --property="Group=${custody[1]}" --property=RuntimeMaxSec=180 \
 --property=TimeoutStopSec=10 --property=KillMode=control-group --property=Restart=no \
 --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
 --property=ReadOnlyPaths=/tmp --property=ReadOnlyPaths=/var/tmp \
 --property="ReadWritePaths=/var/lib/capture402-e2e/facilitator/faucet-stock-setup /var/lib/capture402-e2e/facilitator/campaign-budget /var/lib/capture402-e2e/facilitator/b3-admission" \
 --property="InaccessiblePaths=-/etc/sac006 -/var/lib/sac006 -/opt/capture402 -/opt/capture402-legacy -/etc/capture402-dev -/var/lib/capture402-dev -/opt/capture402-dev -/home/capture402-dev /etc/capture402-e2e/keys /etc/capture402-e2e/facilitator.env /etc/capture402-e2e/restaurant.env -/run/systemd/private -/run/dbus" \
 --property="BindReadOnlyPaths=/run/credentials/${unit}.service/stock-hosts:/etc/hosts" \
 --property=CapabilityBoundingSet= --property=AmbientCapabilities= "${credentials[@]}" \
 --property=RestrictAddressFamilies="AF_INET AF_INET6" --property=IPAddressDeny=any --property="IPAddressAllow=${rpc_ips[*]}" \
 --property=SocketBindDeny=any --property="SystemCallFilter=~bind listen" --property=SystemCallErrorNumber=EPERM \
 --property=RestrictNamespaces=yes --property=RestrictSUIDSGID=yes --property=ProtectKernelTunables=yes \
 --property=ProtectKernelModules=yes --property=ProtectControlGroups=yes --property=ProtectProc=invisible \
 --property=ProcSubset=pid --property=ProtectClock=yes --property=LockPersonality=yes --property=UMask=0077 \
 --property="WorkingDirectory=$snapshot/integration" \
 "$snapshot/node/bin/node" --experimental-strip-types "$snapshot/integration/operators/faucet-stock-operator.ts" "$1" --profile e2e
