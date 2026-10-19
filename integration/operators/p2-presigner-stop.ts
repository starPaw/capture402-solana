// A specific owner-approved continuation, never a general UNKNOWN recovery route.
import { operationalValue } from '../src/operational-data.ts';
export function acceptedPreSignerStop():{source:string;entry:string;manifest:string} {
  const value=operationalValue<{source:string;entry:string;manifest:string}>('preSignerStop');
  if(!value || !/^[a-f0-9]{40}$/.test(value.source) || !/^[a-f0-9]{64}$/.test(value.entry) || !/^[a-f0-9]{64}$/.test(value.manifest))throw Error('trusted pre-signer acceptance missing');
  return value;
}
export function credentialDirectory(directory: unknown): string {
  if (typeof directory !== 'string' || !/^\/run\/credentials\/capture402-e2e-p2-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.service$/.test(directory)) throw Error('scoped ephemeral signer credentials required');
  return directory;
}
export type PreSignerStop = {
  schema: 1; reason: 'SYSTEMD_SERVICE_SUFFIX_REJECTED_BEFORE_SDK_SIGNER';
  stoppedSourceRevision: string; stoppedEntrypointSha256: string; stoppedManifestSha256: string;
  originalIntentSha256: string; originalPlanHash: string; observedCredentialDirectory: string;
};
export type PreSignerContinuation = { stop: PreSignerStop; attestationSha256: string; ownerApprovalReference: string };
export function validatePreSignerContinuation(value: PreSignerContinuation): void {
  const {source:STOPPED_P2_SOURCE,entry:STOPPED_P2_ENTRY,manifest:STOPPED_P2_MANIFEST}=acceptedPreSignerStop();
  const s = value.stop;
  if (!s || s.schema !== 1 || s.reason !== 'SYSTEMD_SERVICE_SUFFIX_REJECTED_BEFORE_SDK_SIGNER' || s.stoppedSourceRevision !== STOPPED_P2_SOURCE || s.stoppedEntrypointSha256 !== STOPPED_P2_ENTRY || s.stoppedManifestSha256 !== STOPPED_P2_MANIFEST || ![s.originalIntentSha256, s.originalPlanHash, value.attestationSha256].every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)) || typeof value.ownerApprovalReference !== 'string' || !value.ownerApprovalReference.trim()) throw Error('specific approved pre-signer stop required');
  credentialDirectory(s.observedCredentialDirectory);
  // The pinned old entry point rejects every such path before loadKeypair.
  // Root-operator attestation + explicit new approval are required; missing wires alone prove nothing.
}
