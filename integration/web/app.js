import { browserProfile, profileAmount, profileLabel } from './payment-profile.js';
import { wallets, onWallets, connect, walletSign, walletSignFaucetRequest, walletSignMerchantDemo, walletSignOrderSession, encodeEnvelope, decodeEnvelope, signingReport, assertDevnetPolicy } from './wallet.js';
import { definitiveReceipt, recoveryMatches, authorizeIsolationMatches } from './receipt-state.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const explorer = (kind, value) => `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=devnet`;
const addressLink = value => `<a href="${explorer('address',value)}" target="_blank" rel="noopener noreferrer">${esc(value)} ↗</a>`;
const diagnosticOnly = new URLSearchParams(location.search).get('walletDiagnostic') === '1';
let nextTarget = '', lastActionError = '', sessionLost = false;
let walletEpoch = 0, restoringWallet = false, manualWalletChoice = false;
const reconnectAttempts = new WeakSet();
let faucetAvailability;
const amount=key=>profileAmount(config,key);
const amountText=key=>profileLabel(config,key);
const circle=()=>browserProfile(config).id==='circle-usdc-v1';
const claimLabel=()=>circle()?`Get ${amountText('faucetAmount').replace(' USDC',' Devnet USDC')}`:`Claim ${amountText('faucetAmount')}`;
let config, order, scenario = 'normal', connection, busy = false, stale = false, reading = false;
let anchor = { clock: 0, at: Date.now() }, merchantSecret = '', accessId = '', credentialEpoch = 0, renderedClockStage = '', demoGrant;
const storedId = () => localStorage.getItem('capture402-order');
const faucetOriginal = () => localStorage.getItem('capture402-faucet-original');
const faucetStopped = () => !!faucetOriginal();
const uncertain = () => !!order && localStorage.getItem('capture402-uncertain') === order.id;
const recoveryAllowed = () => !!order && recoveryMatches(order.b3Recovery,order,localStorage.getItem('capture402-uncertain'));
const continued = () => recoveryAllowed() && order.b3Recovery.continued === true && order.remaining === 0 && localStorage.getItem('capture402-reclaim-uncertain') !== order.id;
const renewedReclaim = () => !!order?.reclaimGeneration;
const reclaimAttempted = () => order?.reclaimDraftState === 'stopped' || (renewedReclaim() ? localStorage.getItem(`capture402-reclaim-wallet-attempt-${order.id}`) === order.reclaimGeneration : localStorage.getItem('capture402-reclaim-wallet-attempt') === order?.id);
const signedOffer = () => !!order && localStorage.getItem('capture402-wallet-attempt') === order.id;
const isolatedAuthorize=()=>authorizeIsolationMatches(order?.authorizeIsolation,order);
const canReplace = () => !!order && !stale && (isolatedAuthorize() || (!uncertain() || continued()) && order.status !== 'pending' && order.remaining === 0 &&
  !(signedOffer() && order.status === 'draft') && (expiredDraft() || ['closed','rejected','abandoned'].includes(order.status)));
const setStatus = (message, error = false) => { $('action-status').hidden = !message; $('action-status').textContent = message; $('action-status').classList.toggle('connection-error', error); };
const safeOperatorTransport = () => { try { assertDevnetPolicy(config); return location.protocol === 'https:' && config.configured === true; } catch { return false; } };
const clockNow = () => anchor.clock + Math.floor((Date.now() - anchor.at) / 1000);
const clockStage = () => order ? `${clockNow() >= order.captureDeadline}:${clockNow() >= order.refundDeadline}` : 'no-offer';
const expiredDraft = () => order?.status === 'draft' && order.events.length === 0 && clockNow() >= order.captureDeadline;
const merchantAuthorization=()=>demoGrant && demoGrant.order===order?.id && demoGrant.payer===connection?.account?.address && clockNow()<demoGrant.expiresAt ? demoGrant.authorization : merchantSecret ? `Bearer ${merchantSecret}` : '';
function lockMerchant(message = config?.publicMerchantDemoEnabled ? 'Enable controls with the original payer wallet. Only this test order is allowed.' : 'Operator-only: separate merchant secret. Payer signing cannot unlock access.') {
  merchantSecret = ''; demoGrant=undefined; accessId = ''; credentialEpoch++; $('merchant-secret').value = '';
  $('operator-status').textContent = message;
}
// A memory-only secret must not survive a history/BFCache restoration or tab navigation.
for (const event of ['pagehide', 'beforeunload']) window.addEventListener(event, () => lockMerchant());
window.addEventListener('pageshow', event => { if (event.persisted) { lockMerchant(); stale = true; render(); } });
async function request(path, init = {}, allowed = []) {
  const target = new URL(path, location.origin);
  if (target.origin !== location.origin || !path.startsWith('/')) throw new Error('Same-origin request required.');
  const operator = !!init.headers?.Authorization;
  if (operator && !safeOperatorTransport()) throw new Error('Merchant operator access requires HTTPS on the configured Devnet demo.');
  // No redirects can carry an operator bearer to another endpoint or origin.
  let response;
  try { response = await fetch(path, { ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(450_000) }); }
  catch { throw new Error('Response unavailable. Inspect original signatures; this operation will not be retried.'); }
  let data; try { data = await response.json(); } catch { throw new Error('Response unavailable. Inspect the original order; do not repeat a paid action.'); }
  if (operator && response.status === 401) { lockMerchant('Operator-only: missing or invalid merchant credential. Payer signing cannot unlock access.'); throw new Error('Operator-only: merchant credential refused.'); }
  if (!response.ok && !allowed.includes(response.status)) {
    // Never render provider/server error text from a credential-bearing request.
    if (operator) throw new Error(response.status === 503 ? 'Merchant operator access is unavailable; private configuration is required.' : 'Merchant action refused: finalized RPC evidence unavailable, order conflict or deadline expired. Refresh the original order.');
    if (data.code === 'order_session_unavailable') sessionLost = true;
    throw new Error(data.error ?? data.receipt?.errorReason ?? `HTTP ${response.status}. Inspect the original order.`);
  }
  return { response, data };
}
function renderWallet() {
  const payer = connection?.account?.address;
  $('payer-key').textContent = payer ?? 'No wallet connected';
  $('wallet-label').textContent = connection ? connection.wallet.name : 'Your Solana wallet';
  $('connect-wallet').textContent = payer ? 'Change wallet' : 'Connect wallet';
  $('detail-payer').innerHTML = order?.payer ? addressLink(order.payer) : payer ? addressLink(payer) : 'Not connected';
}
function authorizeReason() {
  return faucetStopped() ? 'Check the original test-token request before new economics.' : busy ? 'One operation is already in flight.' : stale ? 'Current order state unavailable; refresh the original order.' : storedId() && !order ? 'Original order could not be restored. Keep its identifier and receipts; no replacement payment.' : !config?.configured ? 'Devnet backend provisioning required.' : uncertain() ? 'Original response unknown; inspect its signatures. No new signature or offer.' : !connection?.account ? 'Connect the payer wallet first.' : order && order.payer !== connection.account.address ? 'Connect the original payer wallet.' :
    !order ? 'Prepare an unsigned offer and review its original terms first.' : order?.status === 'abandoned' ? 'Expired unfunded authorization archived. Explicitly prepare a new offer; original terms remain unchanged.' : order && order.status !== 'draft' ? 'Authorization submitted; original receipt below.' : signedOffer() ? 'Original wallet consent retained. Inspect the original draft; no new signature.' : expiredDraft() ? 'Unsigned offer expired. Explicitly prepare a new offer before signing.' : order?.balances?.payer && (order.balances.payer.amount === null || order.balances.payer.amount < amount('budget')) ? order.balances.payer.reason || `Payer needs ${amountText('budget')}; operator funding required.` : '';
}
function refundReason() {
  const refundable = Number(order.refundableBaseUnits) / 1_000_000;
  const refund = order.scenario === 'normal' ? amount('refundExample') : refundable;
  if (!Number.isFinite(refundable) || !Number.isFinite(refund) || refund <= 0 || refundable < refund) return 'Finalized refundable balance cannot cover the selected refund.';
  if (order.balances?.merchant?.amount === null || !Number.isFinite(order.balances?.merchant?.amount) || order.balances.merchant.amount < refund) return 'Merchant test-token balance cannot fund this refund.';
  return '';
}
function merchantReason(action) {
  const reason = faucetStopped() ? 'Check the original test-token request before new economics.' : diagnosticOnly ? 'Signing-only diagnostic disables merchant operations.' : !safeOperatorTransport() ? 'Merchant access requires HTTPS and configured Devnet.' : !order ? 'Original payer order required.' : busy ? 'One operation is already in flight.' : uncertain() ? 'Original response unknown; all new operations are locked.' : stale ? 'Current order state unavailable; refresh the original order.' : accessId !== order.id || !merchantAuthorization() ? config?.publicMerchantDemoEnabled ? 'Enable demo controls for this order with your payer wallet.' : 'Merchant operator access required.' :
    clockNow() >= (action === 'refund' ? order.refundDeadline : order.captureDeadline) ? 'Deadline reached on the informational timer; refresh Solana Clock eligibility.' : !order.actions?.[action] ? order.actionReasons?.[action] || 'Original finalized payment is not eligible for this action.' : '';
  return reason || (action === 'refund' ? refundReason() : '');
}
function render() {
  $('session-recovery').hidden = !config?.publicMerchantDemoEnabled || !storedId() || !!order && !sessionLost || diagnosticOnly;
  $('restore-order-session').disabled = busy || reading || !safeOperatorTransport() || !connection?.account;
  $('faucet-panel').hidden = false;
  $('claim-test-tokens').textContent=claimLabel();
  $('faucet-hint').textContent=`A separate wallet message requests ${amountText('faucetAmount')}; one claim per wallet every 24 hours, limited treasury supply and approved campaign budget. Devnet SOL for payer reclaim fees is separate.`;
  $('lab-intro').textContent=`Reserve ${amountText('budget')}. Capture in parts. Return unused.`;
  $('terms-heading').textContent=`${amountText('budget')} maximum`;
  document.querySelector('[data-action=beer]').textContent=circle()?`Capture ${amountText('firstCapture')}`:`Collect ${amount('firstCapture')}`;
  document.querySelector('[data-action=salmon]').textContent=circle()?`Capture ${amountText('secondCapture')}`:`Collect ${amount('secondCapture')}`;
  document.querySelector('[data-action=atomic]').textContent=`Capture ${amountText('firstCapture')} + release ${amount('budget')-amount('firstCapture')} ${browserProfile(config).assetLabel} atomically`;
  document.querySelector('[data-scenario=normal]').textContent=`Complete · capture ${amountText('firstCapture')} + ${amountText('secondCapture')}, release ${amountText('releaseRemainder')}`;
  document.querySelector('[data-scenario=partial-reclaim]').textContent=`Stop early · capture ${amountText('firstCapture')}, reclaim remainder`;
  document.querySelector('.network').textContent=`Solana Devnet · ${browserProfile(config).assetLabel}`;
  $('claim-test-tokens').disabled = !config?.faucetEnabled || circle() && faucetAvailability?.available!==true || diagnosticOnly || busy || faucetStopped() || uncertain() || stale || !connection?.account || !!order && (order.status==='draft' || order.remaining>0 || order.status==='pending');
  $('faucet-availability').textContent = !config ? 'Checking test-token availability…' : !config.faucetEnabled ? 'Test-token claims are unavailable on this deployment.' : diagnosticOnly ? 'Test-token claims are disabled in signing diagnostics.' : busy ? 'Wait for the current operation.' : faucetStopped() ? 'Check the original token request below before another claim.' : uncertain() ? 'Original payment outcome unknown. Inspect its signatures before claiming tokens.' : stale ? 'Current state unavailable. Observe original state before claiming tokens.' : !connection?.account ? 'Connect your Devnet wallet to claim free test tokens.' : order && (order.status === 'draft' || order.remaining > 0 || order.status === 'pending') ? 'The original order must be resolved before another token claim.' : circle() && faucetAvailability?.available!==true?faucetAvailability?.reason||'Checking Devnet treasury availability…':`Ready: request ${amountText('faucetAmount')} with a wallet message.`;
  $('refresh-test-tokens').hidden = !faucetStopped();
  $('refresh-test-tokens').disabled = busy;
  $('enable-demo-controls').hidden=!config?.publicMerchantDemoEnabled;
  $('enable-demo-controls').disabled=busy || diagnosticOnly || stale || faucetStopped() || uncertain() || !order || order.status==='draft' || connection?.account?.address!==order.payer || clockNow()>=order.refundDeadline;
  $('operator-credentials').hidden=!!config?.publicMerchantDemoEnabled;
  if(config?.publicMerchantDemoEnabled && !merchantSecret && !demoGrant)$('operator-status').textContent='Enable controls with the original payer wallet. Only this test order is allowed.';
  $('merchant-heading').textContent=config?.publicMerchantDemoEnabled?'2–4 · Test this order as the merchant':'2–4 · Merchant operator only';
  $('merchant-control-hint').textContent=config?.publicMerchantDemoEnabled?'Wallet consent enables fixed actions for this order only, until its original refund deadline. Access stays in this tab; reload requires fresh consent.':'Explicit actions only. The secret stays in this tab’s memory and is cleared on lock or navigation. Pending or unknown results stay locked.';
  $('authority-description').textContent=config?.publicMerchantDemoEnabled?'The existing merchant signs onchain. Your readable wallet consent enables only this original test order and fixed scenario actions. Other orders, amounts and deadlines cannot be selected.':'Payer signing, wallet, order ID and cookie never grant merchant authority. The separate operator secret stays only in current-tab memory and is cleared on lock or navigation.';
  $('setup-notice').hidden = !!config?.configured; document.body.classList.toggle('has-order', !!order); document.body.classList.toggle('operator-locked', accessId !== order?.id || !merchantAuthorization());
  for (const key of ['authorized','captured','remaining','refunded']) $(key).textContent = order && Number.isFinite(order[key]) ? order[key].toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—';
  $('refundable').textContent = order?.refundableBaseUnits !== undefined ? (Number(order.refundableBaseUnits) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—';
  const state = order?.status ?? 'idle';
  $('payment-state').textContent = stale ? sessionLost ? 'Session expired · restore access' : 'State unavailable · paused' : isolatedAuthorize() ? 'Expired authorization preserved · new order available' : continued() ? 'Hold reclaimed · original refusal archived' : recoveryAllowed() ? 'Historical capture evidence retained · payer reclaim separate' : uncertain() ? 'Unknown response · locked' : ({ idle:'Awaiting authorization', abandoned:'Expired unfunded draft archived', draft:'Unsigned offer', active:'Finalized', closed:'Hold closed', pending:'Pending · inspect signatures', rejected:'Authorization refused' })[state] ?? state;
  $('payment-state').classList.toggle('live', !stale && !uncertain() && ['active','closed'].includes(state));
  $('released-copy').hidden = !(order?.released > 0); $('released-copy').textContent = order?.released > 0 ? `${order.released} ${browserProfile(config).assetLabel} released to payer` : 'No tokens released yet.';
  const reason = authorizeReason(); $('authorize').disabled = !!reason; $('authorize-reason').textContent = reason || `Ready: sign the exact ${amountText('budget')} offer. Settlement must finalize.`;
  $('authorize').textContent = diagnosticOnly ? 'Sign only · compare wallet response' : busy ? 'Waiting for original result…' : `Authorize ${circle()?'up to ':''}${amountText('budget')}`;
  document.querySelectorAll('[data-action]').forEach(b => { const reason = merchantReason(b.dataset.action); b.disabled = !!reason; b.title = reason; document.querySelector(`[data-reason="${b.dataset.action}"]`).textContent = reason || 'Ready.'; });
  document.querySelector('[data-action=atomic]').closest('.step').hidden = (order?.scenario ?? scenario) !== 'atomic';
  document.querySelector('[data-action=refund]').textContent = (order?.scenario ?? scenario) === 'normal' ? `Refund ${circle()?amountText('refundExample'):amount('refundExample')}` : 'Merchant-funded refund';
  $('finish').textContent = circle()?`Release ${(order?.scenario ?? scenario)==='refund'?`${amount('budget')-amount('firstCapture')} ${browserProfile(config).assetLabel}`:amountText('releaseRemainder')}`:`Release unused ${(order?.scenario ?? scenario)==='refund'?amount('budget')-amount('firstCapture'):amount('releaseRemainder')}`;
  $('unlock-merchant').disabled = busy || !safeOperatorTransport() || !order || uncertain() || stale;
  $('lock-merchant').hidden = !merchantSecret && !demoGrant; $('merchant-secret').disabled = busy || !!merchantSecret;
  if (!safeOperatorTransport()) $('operator-status').textContent = 'Operator-only controls require HTTPS on the configured Devnet demo.';
  $('reclaim-box').hidden = !order || order.remaining <= 0;
  const payerMatches = order?.payer === connection?.account?.address;
  $('reclaim').disabled = faucetStopped() || diagnosticOnly || busy || stale || uncertain() && !recoveryAllowed() || reclaimAttempted() || renewedReclaim() && order.reclaimDraftState !== 'ready' || localStorage.getItem('capture402-reclaim-uncertain') === order?.id || !payerMatches || !order?.actions?.reclaim;
  $('renew-reclaim').hidden = faucetStopped() || !order?.reclaimPreparation || diagnosticOnly || busy || stale || !payerMatches || uncertain() && !recoveryAllowed() || renewedReclaim() && reclaimAttempted() || !!localStorage.getItem(`capture402-reclaim-signed-${order.id}`) || localStorage.getItem('capture402-reclaim-uncertain') === order.id;
  $('reclaim').textContent = renewedReclaim() ? 'Request payer signature for retained draft' : recoveryAllowed() ? 'Resume payer reclaim · preserve original refusal evidence' : 'Reclaim remaining hold';
  $('reclaim-description').textContent = localStorage.getItem('capture402-reclaim-uncertain') === order?.id ? 'Separate reclaim outcome UNKNOWN; retain its original signature and stop.' : order?.reclaimDraftState === 'expired-or-unavailable' ? 'Retained unsigned draft expired or unavailable. Explicit preparation requires fresh canonical finalized expiry and custody proof; nothing is signed.' : order?.reclaimDraftState === 'stopped' ? 'Reclaim consent or attempt retained; further signing and preparation stopped.' : recoveryAllowed() ? 'Reviewed source-bound pre-dispatch evidence; fresh payer consent reclaims the expired hold. Original latch remains archived; this is a new operation.' : uncertain() ? 'Original response unknown; inspect its signatures.' : stale ? 'Current order state unavailable.' : !payerMatches ? 'Connect the original payer wallet to reclaim.' : order?.actionReasons?.reclaim || 'Ready for payer-direct reclaim; the facilitator is not used.';
  document.querySelectorAll('[data-scenario]').forEach(b => { b.classList.toggle('selected', b.dataset.scenario === scenario); b.setAttribute('aria-pressed', String(b.dataset.scenario === scenario)); b.disabled = faucetStopped() || busy || !!order && !canReplace(); });
  $('new-budget').hidden = faucetStopped() || busy || !canReplace();
  $('abandon-authorize').hidden = diagnosticOnly || busy || stale || uncertain() || !order?.authorizeAbandonEligible || !!localStorage.getItem(`capture402-signed-${order?.id}`);
  $('new-budget').textContent = expiredDraft() ? 'Replace expired unsigned offer explicitly' : 'Prepare a new offer explicitly';
  const balanceText = (role, fallback) => { const b = order?.balances?.[role]; return b ? `${role === 'payer' ? 'Payer' : 'Merchant'} test-mint balance: ${b.amount === null ? 'unavailable' : b.amount} ${b.reason}` : fallback; };
  $('payer-balance').textContent = balanceText('payer', 'Test-mint funding checked before an offer is prepared.');
  const native = order?.balances?.payerSol;
  const nativeAmount = native?.lamports != null ? BigInt(native.lamports) : null;
  $('payer-sol-balance').textContent = native ? `Payer Devnet SOL: ${nativeAmount === null ? 'unavailable' : `${nativeAmount / 1000000000n}.${String(nativeAmount % 1000000000n).padStart(9,'0')}`}. ${native.reason || 'Needed for reclaim network fees. Test tokens cannot pay SOL fees.'}` : 'Payer Devnet SOL is needed for reclaim network fees. Test tokens cannot pay SOL fees.';
  $('merchant-balance').textContent = balanceText('merchant', 'Merchant test-mint balance awaits an original order.');
  $('program-id').innerHTML = config ? addressLink(config.programId) : 'Loading accepted deployment…';
  $('mint-id').innerHTML = config?.mint ? `${addressLink(config.mint)} · six-decimal classic SPL test mint` : 'Awaiting test-mint provisioning';
  $('payment-id').innerHTML = order ? addressLink(order.payment) : 'No original offer';
  $('state-pair').textContent = order?.heldBaseUnits !== undefined ? `H=${order.heldBaseUnits} · F=${order.refundableBaseUnits} base units (finalized)` : 'No finalized payment account yet.';
  $('deadline-terms').textContent = order ? `Capture: ${new Date(order.captureDeadline * 1000).toISOString()}. Refund: ${new Date(order.refundDeadline * 1000).toISOString()}. Immutable original terms; eligibility uses Solana Clock.` : '150 seconds from offer generation; refund deadline 30 seconds later. UI timer is informational.';
  if (order?.events?.length) $('timeline').innerHTML = order.events.map(e => `<div class="timeline-event"><span>${e.status === 'finalized' ? '✓' : '◷'}</span><div><strong>${esc(e.label)} · ${esc(e.amount)} ${esc(browserProfile(config).assetLabel)}</strong><div class="event-meta"><small>${esc(new Date(e.at).toLocaleTimeString())}</small><span>${esc(e.status)}${e.chainStatus?.commitment ? ` · ${esc(e.chainStatus.commitment)}` : ''}</span></div></div>${e.signature ? `<a href="${explorer('tx', e.signature)}" target="_blank" rel="noopener noreferrer">${esc(e.signature)} ↗</a>` : '<small>No submitted signature</small>'}</div>`).join('');
  else $('timeline').innerHTML = '<p>No transactions yet. Only original transaction signatures link to Devnet Explorer.</p>';
  renderedClockStage = clockStage(); renderWallet(); renderClock(); renderLab();
}
// Presentation only: route the guided action through the original guarded control.
// A rendered suggestion is never authority, a receipt, or a new recovery policy.
function renderLab() {
  const currentScenario = order?.scenario ?? scenario;
  const known = !!order && order.heldBaseUnits !== undefined;
  $('original-order').textContent = order ? `Original order ${order.id} · ${currentScenario}` : storedId() ? `Retained original order ${storedId()} · restoration required` : 'No original offer issued.';
  $('original-terms').textContent = order ? `Original maximum: ${amountText('budget')}. Capture deadline: ${new Date(order.captureDeadline * 1000).toISOString()}. Refund deadline: ${new Date(order.refundDeadline * 1000).toISOString()}. These terms cannot be extended.` : 'The capture deadline is fixed when the offer is issued. Review the unsigned offer before signing; new terms require a separate authorization.';
  $('path-description').textContent = currentScenario === 'partial-reclaim' ? `Capture ${amountText('firstCapture')}, then wait for the original deadline and request payer reclaim of the unused ${amount('budget')-amount('firstCapture')} ${browserProfile(config).assetLabel}. No work is performed.` : currentScenario === 'normal' ? `Capture ${amountText('firstCapture')}, capture ${amountText('secondCapture')}, then explicitly release ${amountText('releaseRemainder')}. No work is performed.` : `Advanced path: ${currentScenario}. Its original scenario and payment rules remain in force.`;
  const number = value => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits:6 }) : '—';
  $('released').textContent = known ? number(order.released) : '—';
  if (!known) for (const id of ['captured','remaining']) $(id).textContent = '—';
  $('totals-caption').textContent = stale ? 'Last observed amounts; current finalized state unavailable.' : uncertain() || order?.status === 'pending' ? 'Original snapshot only; pending or UNKNOWN operations may change these amounts.' : known ? `Finalized payment snapshot · ${browserProfile(config).assetLabel}. Merchant-funded refunds are separate in Advanced.` : 'No finalized payment account observed; unavailable amounts are not zero.';
  for (const [id,key] of [['bar-paid','captured'],['bar-held','remaining'],['bar-returned','released']]) $(id).style.width = known && Number.isFinite(order[key]) ? `${Math.max(0,Math.min(100,order[key]/amount('budget')*100))}%` : '0%';
  const events = order?.events ?? [];
  const finalized = events.filter(e => e.status === 'finalized').length;
  const unresolved = events.filter(e => ['pending','prepared'].includes(e.status)).length;
  $('receipt-summary').textContent = order ? `${finalized} finalized · ${unresolved} prepared or pending · ${events.filter(e=>e.status==='rejected').length} rejected. ${known ? `Paid ${number(order.captured)}, held ${number(order.remaining)}, returned unused ${number(order.released)} ${browserProfile(config).assetLabel}.` : 'No finalized account observed.'} Original events and signatures are retained below.` : 'No original receipts yet. Approval alone does not confirm payment.';
  $('prepare-offer').disabled = busy || reading || stale || faucetStopped() || !config?.configured || !connection?.account || !!order || !!storedId();
  let title = 'Check readiness', message = '', actor = 'Observe only', label = 'Observe original state', target = 'refresh';
  const choose = (heading, text, role, button, id) => { title=heading;message=text;actor=role;label=button;target=id; };
  const reclaimUnknown = !!order && localStorage.getItem('capture402-reclaim-uncertain') === order.id;
  if (busy || reading) choose('Waiting for the original result', 'One operation is in progress. Approval is not finalized payment; do not repeat it.', 'Observe only', 'Waiting for original result…', '');
  else if (faucetStopped()) choose('Test-token request unresolved', 'Check the original token request only. No second claim or payment while its outcome is unresolved.', 'Observe original request', 'Check original token request', 'refresh-test-tokens');
  else if (!$('session-recovery').hidden) choose('Restore the original order', 'The retained order needs browser access. Sign a message with its original payer wallet to restore the same receipts. No payment or token claim is submitted.', 'Original payer · access-only message', connection?.account ? 'Restore original order with my wallet' : 'Connect original payer wallet', connection?.account ? 'restore-order-session' : 'connect-wallet');
  else if (stale) choose('Current state unavailable', 'Actions are paused. Amounts are last observed, not current. Observe this original order or open the illustration in a separate tab. Keep recovery information.', 'Read-only observation', 'Observe original state', 'refresh');
  else if (!config?.configured) choose('Live lab unavailable', 'Backend provisioning is required. Keep any original order; the illustration is available in a separate tab.', 'No payment available', 'Live lab unavailable', '');
  else if (storedId() && !order) choose('Original order unavailable', 'Keep its identifier and receipts. Wallet connection cannot recreate session access. Do not create a replacement payment.', 'Read-only observation', 'Observe original state', 'refresh');
  else if (reclaimUnknown || uncertain() && !recoveryAllowed() && !isolatedAuthorize()) choose('UNKNOWN · keep this order', 'The operation may have executed. Keep original signed bytes, signatures and locks. Observe original evidence; do not pay again.', 'Read-only observation', 'Observe original state', 'refresh');
  else if (order?.status === 'pending' && !isolatedAuthorize()) choose('Pending · await finalized evidence', 'Inspect the original signature. No new authorization or merchant action is eligible while this operation is pending.', 'Read-only observation', 'Observe original state', 'refresh');
  else if (canReplace()) choose(order.status === 'closed' ? 'Completed · hold closed' : 'Original preserved', isolatedAuthorize() ? 'Original outcome remains UNKNOWN and its reserve is retained. Only the existing verified isolation permits an explicit unsigned successor.' : 'Inspect original receipts. You may explicitly prepare a separate offer under new terms; this does not reset the original deadline.', 'Payer · unsigned preparation only', connection?.account ? $('new-budget').textContent : 'Connect wallet for a new offer', connection?.account ? 'new-budget' : 'connect-wallet');
  else if (!connection?.account || order && connection.account.address !== order.payer) choose('Connect the payer wallet', order ? 'Use the original payer wallet. This order and its immutable terms stay selected.' : 'Connection moves no tokens. Then prepare an unsigned offer to review the actual terms.', 'Payer · connection only', 'Connect wallet', 'connect-wallet');
  else if (!order && /test.mint|funding required|needs 100|token account missing/i.test(lastActionError)) choose('Test tokens required', lastActionError + ' Devnet SOL is also needed for reclaim fees.', 'Payer · separate message consent if available', !$('claim-test-tokens').disabled ? claimLabel() : 'Inspect funding requirements', !$('claim-test-tokens').disabled ? 'claim-test-tokens' : 'advanced');
  else if (!order) choose('Prepare original terms', `Request an unsigned ${amountText('budget')} offer, then review its original deadline before a separate wallet signature.`, 'Payer · unsigned preparation only', 'Prepare unsigned offer', 'prepare-offer');
  else if (order.status === 'draft') {
    if (signedOffer()) choose('Wallet approval retained', /reject|declin|denied|cancel/i.test(lastActionError) ? 'Wallet approval was declined. The original attempt is retained; do not assume non-execution or sign again. Inspect this order.' : 'The original wallet consent attempt is retained. Inspect its state; do not request another signature.', 'Observe original attempt', 'Observe original state', 'refresh');
    else if (expiredDraft()) choose('Original offer expired', 'The original deadline has not been extended. Inspect the original attempt and its explicit replacement eligibility.', 'Read-only observation', 'Observe original state', 'refresh');
    else if (order.balances?.payer?.amount === null || order.balances?.payer?.amount < amount('budget')) choose('Test tokens required', order.balances.payer.reason || `The original payer needs ${amountText('budget')}. Funding is separate and explicit; Devnet SOL is also needed for reclaim fees.`, 'Payer · separate message consent if available', !$('claim-test-tokens').disabled ? claimLabel() : 'Inspect funding requirements', !$('claim-test-tokens').disabled ? 'claim-test-tokens' : 'advanced');
    else choose('Review and authorize', `Original maximum: ${amountText('budget')}. Capture deadline: ${new Date(order.captureDeadline * 1000).toISOString()}. Review the original payer and terms below. Your signature authorizes the retained offer; wait for finalized evidence afterward.`, 'Payer · transaction signature', `Authorize ${circle()?'up to ':''}${amountText('budget')}`, 'authorize');
  } else if (order?.reclaimFunding?.reason) choose(order.reclaimFunding.balanceLamports !== null && (order.reclaimFunding.balanceLamports === '0' || order.reclaimFunding.requiredLamports !== null) ? 'Devnet SOL required' : 'Reclaim fee check unavailable', order.reclaimFunding.reason, 'Original payer · network fees', 'Observe original state', 'refresh');
  else if (!$('renew-reclaim').hidden) choose('Fresh reclaim preparation eligible', $('reclaim-description').textContent, 'Payer · unsigned preparation only', 'Prepare fresh reclaim explicitly', 'renew-reclaim');
  else if (!$('reclaim').disabled) choose('Request the unused hold', $('reclaim-description').textContent + ' Already-paid tokens stay with the merchant. Application routes must be available.', 'Original payer · transaction signature', 'Reclaim remaining hold', 'reclaim');
  else {
    const actions = currentScenario === 'normal' ? ['beer','salmon','finish'] : currentScenario === 'partial-reclaim' ? ['beer'] : currentScenario === 'atomic' ? ['atomic'] : currentScenario === 'cancelled' ? ['void'] : currentScenario === 'refund' ? ['beer','refund','finish'] : [];
    const eligible = actions.find(a => order.actions?.[a] && clockNow() < (a === 'refund' ? order.refundDeadline : order.captureDeadline));
    if (eligible && !merchantReason(eligible)) choose('Merchant action eligible', 'This explicitly requests the existing merchant to sign for this order. The program does not verify service delivery.', 'Merchant · existing on-chain signer', document.querySelector(`[data-action="${eligible}"]`).textContent, `action:${eligible}`);
    else if (eligible && config.publicMerchantDemoEnabled && !$('enable-demo-controls').disabled) choose('Merchant demo consent required', 'Your readable wallet message enables only fixed actions on this original order. The merchant remains the on-chain signer; reload requires fresh consent.', 'Original payer · separate message signature', 'Enable merchant demo controls', 'enable-demo-controls');
    else if (eligible) choose('Merchant authorization required', merchantReason(eligible), 'Separate merchant operator', 'Open operator tools', 'operator-tools');
    else choose('Wait / inspect original evidence', order.remaining > 0 ? $('reclaim-description').textContent + ' The original deadline stays fixed; expiry alone returns nothing.' : 'Inspect original receipts and eligibility in Advanced. Do not repeat an unresolved operation.', 'Read-only observation', 'Observe original state', 'refresh');
  }
  if (!$('abandon-authorize').hidden && !busy && !reading && !stale) choose('Expired unfunded draft eligible for archive', 'Only this selected draft has verified archive eligibility. Preserve its original consent; prepare any successor separately.', 'Payer · explicit archive, no signing', 'Archive selected expired unfunded draft', 'abandon-authorize');
  $('next-step').textContent=title; $('readiness').textContent=message; $('next-actor').textContent=actor; $('next-action').textContent=label;
  $('next-reason').textContent = diagnosticOnly ? 'Signing-only diagnostic: no transaction is submitted.' : 'Each step is explicit. Observe refreshes the original state; it does not retry a payment.';
  nextTarget=target;
  const control = target.startsWith('action:') ? document.querySelector(`[data-action="${target.slice(7)}"]`) : $(target);
  $('next-action').disabled = !target || busy || reading || !!control?.disabled;
}
$('next-action').onclick = () => {
  const intendedTarget = nextTarget;
  render(); // A changed suggestion requires another explicit click, never substituted consent.
  if ($('next-action').disabled || nextTarget !== intendedTarget) return;
  if (['advanced','operator-tools'].includes(nextTarget)) {
    $('advanced').open=true;
    (nextTarget === 'operator-tools' ? $('merchant-secret') : $('payer-heading')).focus();
    $('advanced').scrollIntoView({block:'start'}); return;
  }
  const target = nextTarget.startsWith('action:') ? document.querySelector(`[data-action="${nextTarget.slice(7)}"]`) : $(nextTarget);
  if (target && !target.disabled && !target.hidden) target.click();
};
$('prepare-offer').onclick = () => {
  if ($('prepare-offer').disabled || order || storedId()) return;
  return run(prepareOffer);
};
function renderClock() {
  if (!order) { $('clock').textContent = '02:30'; $('clock-label').textContent = '150 seconds from offer generation; no offer yet.'; return; }
  const seconds = Math.max(0, order.captureDeadline - clockNow());
  $('clock').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  $('clock-label').textContent = stale ? 'Last observed Clock; current state unavailable. Eligibility paused.' : seconds > 0 ? 'Offer deadline; eligibility uses Solana Clock.' : 'Capture window closed. Funded or pending deadlines never reset.';
}
async function refresh() {
  void refreshFaucetAvailability();
  const id = storedId(); if (!id || !config?.configured) return;
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Original order ID invalid. Inspect the original order.');
  const { data } = await request(`/api/orders/${encodeURIComponent(id)}`);
  if (storedId() !== id || data.id !== id) throw new Error('Original order changed; inspect its state.');
  const selectedNext = order?.id === data.id && canReplace() ? scenario : data.scenario;
  stale = false; sessionLost = false; order = data; scenario = selectedNext; anchor = { clock: data.now, at: Date.now() }; render();
}
async function run(fn, renewalMessage = '', refreshAfter = true) {
  if (busy || reading) return; busy = true; lastActionError = ''; render(); setStatus('Waiting for the original result. No automatic retry.');
  try {
    await fn(); if(refreshAfter) await refresh();
    const preparedRenewal = renewalMessage && recoveryAllowed() && renewedReclaim() && order.reclaimDraftState === 'ready' && !reclaimAttempted() && order.status !== 'pending' && order.remaining > 0 && order.actions?.reclaim &&
      localStorage.getItem('capture402-reclaim-uncertain') !== order.id;
    setStatus(preparedRenewal ? renewalMessage : isolatedAuthorize() ? 'Successful authorization effect excluded for the expired original. Outcome UNKNOWN and reserve retained; explicitly prepare one new offer.' : order?.status === 'abandoned' ? 'Selected expired unfunded authorization archived; no funds moved. Prepare a new offer separately.' : continued() ? 'Payer reclaim finalized. Historical capture evidence retained; a new scenario may be explicitly prepared.' : recoveryAllowed() && !reclaimAttempted() && order.status !== 'pending' && localStorage.getItem('capture402-reclaim-uncertain') !== order.id ? order.reclaimDraftState === 'expired-or-unavailable' ? 'Historical capture evidence retained. Unsigned reclaim expired or unavailable; explicit preparation requires fresh finalized proof.' : 'Historical capture evidence retained. Separate payer reclaim requires fresh consent and a finalized receipt.' : uncertain() || order?.status === 'pending' ? 'Original operation pending or unknown. All new operations stopped; inspect original signatures.' : 'Original state refreshed. Only finalized receipts confirm settlement.');
  }
  catch (error) { lastActionError = error.message; setStatus(error.message + (diagnosticOnly && signingReport() ? '\n\n' + JSON.stringify(signingReport(),null,2) : ''), true); try { await refresh(); } catch { stale = true; accessId = ''; } }
  finally { busy = false; render(); }
}
async function operatorPreflight(action, candidate = merchantAuthorization()) {
  if (!candidate || candidate.length < 32 || candidate.length > (candidate.startsWith('Demo ')?4096:520) || candidate.trim() !== candidate || /[\r\n]/.test(candidate)) throw new Error('Operator-only: enter a valid separate merchant credential. Payer signing cannot unlock access.');
  if (!order || uncertain()) throw new Error('Original order required and unknown responses must remain locked.');
  const id = order.id, epoch = credentialEpoch;
  const { data } = await request(`/api/orders/${id}/actions/${action}`, { headers: { Authorization: candidate } });
  if (epoch !== credentialEpoch || order.id !== id || data.id !== id || data.operatorAccess !== true) throw new Error('Operator access changed. Unlock the original order explicitly.');
  // Only consume sanitized state fields; the credential is never rendered or persisted.
  order = { ...order, ...data }; anchor = { clock: data.now, at: Date.now() }; stale = false; accessId = id;
}
async function submitOriginal(path, init, allowed = []) {
  const originalId = order.id;
  const wireHash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
  localStorage.setItem(`capture402-request-${originalId}`,JSON.stringify({order:originalId,path,method:init.method,
    bodySha256:await wireHash(init.body ?? init.headers?.['PAYMENT-SIGNATURE'] ?? ''),at:new Date().toISOString()}));
  localStorage.setItem('capture402-uncertain', order.id); // Non-secret lost-response lock survives reload.
  const result = await request(path, init, allowed);
  if (order.id !== originalId || localStorage.getItem('capture402-uncertain') !== originalId) return result;
  const receipt = result.data.receipt, encoded = result.response.headers.get('PAYMENT-RESPONSE');
  let header; try { header = encoded ? decodeEnvelope(encoded) : undefined; } catch { /* Keep UNKNOWN. */ }
  if (definitiveReceipt(receipt,header,config.network,order.payer)) localStorage.removeItem('capture402-uncertain');
  else if (receipt && header && JSON.stringify(receipt) === JSON.stringify(header) && receipt.network === config.network && receipt.payer === order.payer && typeof receipt.success === 'boolean' && typeof receipt.transaction === 'string' && receipt.transaction) {
    await refresh();
    const event = order.events.find(e=>e.signature === receipt.transaction);
    if (event?.chainStatus?.kind === 'found' && event.chainStatus.commitment === 'finalized' &&
      (receipt.success === true && event.status === 'finalized' && event.chainStatus.err === null || receipt.success === false && event.status === 'rejected' && event.chainStatus.err !== null)) localStorage.removeItem('capture402-uncertain');
  }
  return result;
}
async function signingPreflight(unsigned, operation, dispatch = false) {
  const {data} = await request(`/api/orders/${order.id}/signing-preflight?operation=${operation}${dispatch ? '&phase=dispatch' : ''}`);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(unsigned))),b=>b.toString(16).padStart(2,'0')).join('');
  if (data.id !== order.id || data.operation !== operation || data.phase !== (dispatch ? 'dispatch' : 'consent') || data.fresh !== !dispatch || data.unsignedSha256 !== hash) throw new Error('Original consent/dispatch preflight evidence differs; signing or submission stopped.');
  return hash;
}
// This public preference is never an order session, merchant grant or consent.
function walletPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem('capture402-wallet') || 'null');
    return saved && typeof saved.name === 'string' && saved.name.length <= 128 && typeof saved.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(saved.address) ? saved : null;
  } catch { return null; }
}
function rememberWallet(wallet, account) {
  if (account) localStorage.setItem('capture402-wallet',JSON.stringify({name:wallet.name,address:account.address}));
  else localStorage.removeItem('capture402-wallet');
}
function walletChanged(epoch, wallet, account) {
  if (epoch !== walletEpoch || connection?.wallet !== wallet) return;
  connection.account = account; rememberWallet(wallet,account); lockMerchant(); render(); void refreshFaucetAvailability();
}
async function restoreRememberedWallet() {
  if (!config?.configured || connection || restoringWallet || manualWalletChoice) return;
  const saved = walletPreference(); if (!saved) return;
  const matches = wallets().filter(wallet => wallet.name === saved.name);
  if (matches.length !== 1 || reconnectAttempts.has(matches[0])) return;
  const wallet = matches[0], epoch = walletEpoch;
  reconnectAttempts.add(wallet); restoringWallet = true;
  try {
    const candidate = await connect(wallet,account => walletChanged(epoch,wallet,account),config,{silent:true,expectedAddress:saved.address});
    const current = walletPreference();
    if (epoch !== walletEpoch || manualWalletChoice || connection || current?.name !== saved.name || current?.address !== saved.address || candidate.account?.address !== saved.address) { candidate.off?.(); return; }
    connection = candidate; render(); void refreshFaucetAvailability();
  } catch { /* Locked, revoked or unavailable wallet: retain the explicit Connect action. */ }
  finally { restoringWallet = false; }
}
function showWallets() {
  const available = wallets(); $('wallet-help').hidden = !!available.length; $('wallet-list').replaceChildren();
  for (const wallet of available) {
    const button = document.createElement('button'); button.className = 'button secondary'; button.textContent = wallet.name;
    button.onclick = async () => {
      const epoch = ++walletEpoch; manualWalletChoice = true;
      connection?.off?.(); connection = undefined; lockMerchant(); render();
      try {
        const candidate = await connect(wallet,account => walletChanged(epoch,wallet,account),config);
        if (epoch !== walletEpoch) { candidate.off?.(); return; }
        connection = candidate; rememberWallet(wallet,candidate.account); void refreshFaucetAvailability();
        $('wallet-dialog').close(); render(); setStatus('Wallet connected. Connection moves no tokens; original payment state retained.');
      } catch (error) { if(epoch === walletEpoch) { setStatus(error.message, true); $('wallet-dialog').close(); render(); } }
    }; $('wallet-list').append(button);
  }
}
onWallets(() => { showWallets(); void restoreRememberedWallet(); });
$('connect-wallet').onclick = () => { manualWalletChoice = true; showWallets(); $('wallet-dialog').showModal(); };
$('close-wallet').onclick = () => $('wallet-dialog').close();
async function prepareOffer() {
  if (!connection?.account) throw new Error('Connect the payer wallet first.');
  if(isolatedAuthorize())localStorage.setItem(`capture402-isolation-archive-${order.id}`,JSON.stringify({originalLatch:localStorage.getItem('capture402-uncertain'),originalWalletAttempt:localStorage.getItem('capture402-wallet-attempt'),evidence:order.authorizeIsolation,acknowledgedAt:new Date().toISOString()}));
  const { response, data } = await request('/api/orders', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ payer:connection.account.address, scenario }) }, [402]);
  const header = response.headers.get('PAYMENT-REQUIRED');
  if (!header || !data.order || !data.unsigned) throw new Error(data.error || 'No real unsigned budget offer could be prepared.');
  const required = decodeEnvelope(header);
  lockMerchant(); localStorage.setItem('capture402-order', data.order); await refresh();
  return { required, unsigned:data.unsigned, id:data.order };
}
$('authorize').onclick = () => {
  if (authorizeReason()) return;
  return run(async () => {
    const draft = order?.status === 'draft' ? order : await prepareOffer();
    const { required, unsigned, id } = draft, offer = required.accepts[0];
    if (offer.amount !== browserProfile(config).budget || offer.asset !== config.mint || offer.payTo !== config.merchant || offer.network !== config.network || offer.extra?.programId !== config.programId || offer.extra?.feePayer !== config.sponsor || offer.extra?.paymentFlow !== 'escrow') throw new Error('Offer differs from fixed policy. Nothing was signed.');
    if (expiredDraft()) throw new Error('Unsigned offer expired; explicitly replace it before signing.');
    const unsignedSha256 = await signingPreflight(unsigned,'authorize');
    if (signedOffer()) throw new Error('Original wallet consent already attempted; inspect its retained original before new signing.');
    await request(`/api/orders/${id}/wallet-consent`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unsignedSha256})});
    localStorage.setItem('capture402-wallet-attempt',id);
    const signed = await walletSign(connection, unsigned, config);
    localStorage.setItem(`capture402-signed-${id}`,signed);
    if (diagnosticOnly) throw new Error('Signing-only diagnostic complete. Nothing was submitted.');
    if (expiredDraft()) throw new Error('Offer expired during wallet approval. Signed original retained; no replacement permitted without evidence.');
    await signingPreflight(unsigned,'authorize');
    const envelope = { x402Version:2, resource:required.resource, accepted:offer, payload:{ transaction:signed } };
    const { data } = await submitOriginal(`/resource?order=${id}`, { method:'POST', headers:{ 'PAYMENT-SIGNATURE':encodeEnvelope(envelope) } }, [402]);
    if (!data.receipt?.success) throw new Error(data.receipt?.errorReason ?? 'Authorization unresolved. Inspect this order.');
  });
};
$('unlock-merchant').onclick = () => run(async () => {
  const candidate = $('merchant-secret').value; $('merchant-secret').value = '';
  try { await operatorPreflight('beer', `Bearer ${candidate}`); merchantSecret = candidate; $('operator-status').textContent = 'Devnet operator access verified. Explicit clicks only.'; }
  catch { lockMerchant('Operator-only: credential refused or finalized RPC evidence unavailable. Verify the separate merchant credential and refresh. Payer signing cannot unlock access.'); throw new Error('Merchant unlock failed; no economic request was sent.'); }
});
$('lock-merchant').onclick = () => { lockMerchant(); render(); };
$('enable-demo-controls').onclick=()=>{
  if($('enable-demo-controls').disabled)return;
  return run(async()=>{
    lockMerchant();const id=order.id,epoch=credentialEpoch;
    const {data:challenge}=await request(`/api/orders/${id}/merchant-demo`,{method:'POST'});
    const signature=await walletSignMerchantDemo(connection,challenge,order,config);
    if(epoch!==credentialEpoch || order.id!==id || connection.account.address!==order.payer)throw new Error('Order or payer changed. Nothing submitted.');
    const encoded=btoa(JSON.stringify({token:challenge.token,signature})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const authorization=`Demo ${encoded}`;
    await operatorPreflight('beer',authorization);
    demoGrant={authorization,order:id,payer:order.payer,expiresAt:challenge.expiresAt};
    $('operator-status').textContent='Controls enabled for this test order only. Choose each action explicitly.';
  });
};

for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => {
  const action = button.dataset.action;
  if (merchantReason(action)) return;
  return run(async () => {
    await operatorPreflight(action);
    const reason = order.actionReasons?.[action] || (action === 'refund' ? refundReason() : '');
    if (!order.actions?.[action] || reason || clockNow() >= (action === 'refund' ? order.refundDeadline : order.captureDeadline)) throw new Error(reason || 'Original action eligibility changed; no operation sent.');
    const { data } = await submitOriginal(`/api/orders/${order.id}/actions/${action}`, { method:'POST', headers:{ Authorization:merchantAuthorization() } }, [409]);
    if (!data.receipt?.success) throw new Error('Merchant operation refused or pending. Inspect original signatures and finalized state.');
  });
};
$('renew-reclaim').onclick = () => {
  if($('renew-reclaim').hidden) return;
  return run(async () => {
    const {data}=await request(`/api/orders/${order.id}/reclaim-renewal`,{method:'POST'});
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.unsigned))),b=>b.toString(16).padStart(2,'0')).join('');
    if(data.payer!==order.payer || data.proof?.kind!=='expired-no-reclaim-effect') throw Error('Renewal proof differs; nothing signed.');
    localStorage.setItem(`capture402-reclaim-renewed-${order.id}`,hash);
    // Use the published response immediately. Optional balance/status refresh must not
    // consume the owner's signing window. Preflight and durable consent still recheck.
    order={...order,reclaimGeneration:hash,reclaimDraftState:'ready',reclaimPreparation:false};
  }, 'Previous reclaim wire archived after finalized no-effect proof. Fresh unsigned draft prepared; request signature separately.', false);
};
$('abandon-authorize').onclick = () => {
  if($('abandon-authorize').hidden)return;
  return run(async()=>{
    const {data}=await request(`/api/orders/${order.id}/abandon-authorize`,{method:'POST'});
    if(data.abandoned!==true || data.proof?.kind!=='expired-unfunded-authorize' || data.proof.payment!==order.payment)throw Error('Abandonment proof differs; no new signature or offer.');
    setStatus('Expired unfunded draft archived. No funds moved; prepare a new offer separately.');
  });
};
$('reclaim').onclick = () => {
  if ($('reclaim').disabled) return;
  return run(async () => {
    const recovery = recoveryAllowed();
    if (recovery) localStorage.setItem(`capture402-recovery-archive-${order.id}`,JSON.stringify({originalLatch:localStorage.getItem('capture402-uncertain'),evidence:order.b3Recovery,acknowledgedAt:new Date().toISOString()}));
    const { data } = await request(`/api/orders/${order.id}/reclaim`);
    const unsignedSha256=await signingPreflight(data.unsigned,'reclaim');
    await request(`/api/orders/${order.id}/wallet-consent?operation=reclaim`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unsignedSha256})});
    localStorage.setItem('capture402-reclaim-wallet-attempt',order.id);
    if(renewedReclaim()) localStorage.setItem(`capture402-reclaim-wallet-attempt-${order.id}`,unsignedSha256);
    const signed = await walletSign(connection, data.unsigned, config);
    localStorage.setItem(`capture402-reclaim-signed-${order.id}-${unsignedSha256}`,signed);
    if(!localStorage.getItem(`capture402-reclaim-signed-${order.id}`)) localStorage.setItem(`capture402-reclaim-signed-${order.id}`,signed);
    await signingPreflight(data.unsigned,'reclaim',true);
    if (recovery) {
      localStorage.setItem('capture402-reclaim-uncertain',order.id);
      const {data:result} = await request(`/api/orders/${order.id}/reclaim`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction:signed})},[409]);
      await refresh();
      if (result.receipt?.success === true && order.events.some(e=>e.action === 'reclaim' && e.signature === result.receipt.transaction && e.status === 'finalized' && e.chainStatus?.commitment === 'finalized' && e.chainStatus.err === null)) localStorage.removeItem('capture402-reclaim-uncertain');
    } else await submitOriginal(`/api/orders/${order.id}/reclaim`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ transaction:signed }) }, [409]);
  });
};
for (const button of document.querySelectorAll('[data-scenario]')) button.onclick = () => { if (!busy && (!order || canReplace())) { scenario = button.dataset.scenario; render(); } };
$('restore-order-session').onclick = () => {
  if ($('session-recovery').hidden || $('restore-order-session').disabled) return;
  return run(async () => {
    const id = storedId(), payer = connection.account.address;
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Retain the original order ID.');
    const {data:challenge} = await request(`/api/orders/${id}/session`);
    const signature = await walletSignOrderSession(connection,challenge,id,config);
    if (storedId() !== id || connection.account.address !== payer) throw Error('Original order or payer changed. Nothing submitted.');
    const {data} = await request(`/api/orders/${id}/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:challenge.token,signature})});
    if (!data.restored || data.order !== id) throw Error('Original session was not restored. Keep its identifier.');
  });
};
$('refresh').onclick = () => run(async () => {
  const candidate = (await request('/api/config')).data;
  assertDevnetPolicy(candidate);
  browserProfile(candidate);
  config = candidate; void restoreRememberedWallet();
  // With no retained order, a successful config read clears a startup failure.
  // A retained order still needs its own successful finalized refresh below.
  if (!storedId()) stale = false;
});
$('new-budget').onclick = () => { if (!$('new-budget').hidden) return run(async () => { await prepareOffer(); setStatus('Fresh unsigned offer prepared by explicit consent. Sign separately; old journals remain intact.'); }); };
function showFaucetResult(data) {
  const retained=JSON.parse(faucetOriginal()||'null');
  if(!retained || data.id!==retained.id || data.recipient!==retained.recipient || data.amount!==amount('faucetAmount') || data.mint!==config.mint)throw new Error('Original test-token response differs. New operations remain stopped.');
  const receipt=$('faucet-receipt');receipt.hidden=!data.signature;
  if(data.signature) {
    if(!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(data.signature))throw new Error('Invalid original token receipt.');
    receipt.textContent=`Original token receipt: ${data.signature} ↗`;
    receipt.href=explorer('tx',data.signature);
  }
  const final=data.status==='finalized'||data.status==='failed';
  if(final && (!data.signature || !/^[0-9]+$/.test(data.finalizedSlot??'')))throw new Error('Finalized token receipt missing.');
  $('faucet-status').textContent=data.status==='finalized'?`${amountText('faucetAmount')} delivered · finalized. Next claim in 24 hours.`:data.status==='failed'?'Original token transaction finalized with an error. No retry.':data.status==='refused'?'Token request refused before sponsor signing. No tokens sent; this request is retained.':'Original token request pending or UNKNOWN. New economics stopped; check this original request only.';
  if(final || data.status==='refused') {
    localStorage.setItem(`capture402-faucet-result-${retained.id}`,JSON.stringify(data));
    localStorage.removeItem('capture402-faucet-original');
  }
  render();
}
async function checkFaucetOriginal() {
  const retained=JSON.parse(faucetOriginal()||'null');
  if(!retained || !/^[a-f0-9]{64}$/.test(retained.id))throw new Error('Retain the original test-token request; no new claim.');
  const {data}=await request(`/api/faucet/claims/${retained.id}`);showFaucetResult(data);
}
$('refresh-test-tokens').onclick=()=>{if(!busy && faucetStopped())return run(checkFaucetOriginal);};
$('claim-test-tokens').onclick=()=>{
  if($('claim-test-tokens').disabled)return;
  return run(async()=>{
    $('faucet-receipt').hidden=true;$('faucet-status').textContent=`Sign the ${amountText('faucetAmount')} request message in your wallet. No payment.`;
    const recipient=connection.account.address;
    const {data:challenge}=await request('/api/faucet/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipient})});
    const signature=await walletSignFaucetRequest(connection,challenge,config);
    localStorage.setItem('capture402-faucet-original',JSON.stringify({id:challenge.id,recipient}));render();
    const {data}=await request('/api/faucet/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:challenge.token,signature})});
    showFaucetResult(data);await refreshFaucetAvailability();
  });
};
async function refreshFaucetAvailability() {
  if(!config?.faucetEnabled || !circle())return;
  const recipient=connection?.account?.address;
  try {faucetAvailability=(await request(`/api/faucet/status${recipient?`?recipient=${encodeURIComponent(recipient)}`:''}`)).data;}
  catch {faucetAvailability={available:false,reason:'Devnet RPC unavailable; treasury status could not be verified.'};}
  render();
}
setInterval(()=>{if(!busy)void refreshFaucetAvailability();},30000);
setInterval(() => { if (!busy && clockStage() !== renderedClockStage) render(); else renderClock(); }, 1000);
setInterval(() => { if (!busy && !reading && order && config?.configured) { reading = true; refresh().catch(error => { stale = true; accessId = ''; render(); setStatus(error.message + ' Original actions paused.', true); }).finally(() => { reading = false; render(); }); } }, 15000);
try { config = (await request('/api/config')).data; assertDevnetPolicy(config); browserProfile(config); render(); void restoreRememberedWallet(); if (diagnosticOnly) setStatus('Signing-only diagnostic: no signed transaction is sent to the backend.'); await refresh(); await refreshFaucetAvailability(); if(config.faucetEnabled && faucetStopped())await checkFaucetOriginal(); } catch (error) { stale = true; render(); setStatus(error.message, true); }
