#!/usr/bin/env python3
"""Bounded design check for docs/account-lifecycle-v2.md, not an SBF test.

Enumerate small payment lifecycles, compare reference monetary transitions with v2
cleanup, and demonstrate counterexamples to unsafe alternatives. Integer token
units and abstract storage deposits keep this independent of a network price.
Ghost history in State belongs to the checker, not to proposed on-chain storage.
"""

from collections import deque
from dataclasses import dataclass, replace
import json


MAXIMUM = 3
INITIAL_TOKENS = 6
DC, DR, UNTIL_SLOT = 2, 3, 1
PAYMENT_DEPOSIT, VAULT_DEPOSIT = 10, 7
MAX_AHEAD = 1500
U64_MAX = (1 << 64) - 1


@dataclass(frozen=True)
class State:
    slot: int = 0
    now: int = 0
    live: bool = False
    vault: bool = False
    h: int = 0
    f: int = 0
    payer: int = INITIAL_TOKENS
    merchant: int = 0
    balance: int = 0
    donated: bool = False
    authorizations: int = 0
    sol_supplied: int = 0
    sol_returned: int = 0


def in_window(slot, until, max_ahead=MAX_AHEAD):
    return 0 <= slot <= until < U64_MAX and until - slot <= max_ahead


def authorize(s):
    if s.live or s.now >= DC or not in_window(s.slot, UNTIL_SLOT):
        return None
    if s.payer < MAXIMUM:
        return None
    return replace(s, live=True, vault=True, h=MAXIMUM, f=0,
                   payer=s.payer - MAXIMUM, balance=s.balance + MAXIMUM,
                   authorizations=s.authorizations + 1,
                   sol_supplied=s.sol_supplied + PAYMENT_DEPOSIT
                   + (0 if s.vault else VAULT_DEPOSIT))


def monetary(s, op, amount=0, release=False, fail_leg=0):
    """Reference H/F semantics, with atomic transfers abstracted as a commit plan.

    fail_leg models Token CPI rejection (including a failing second release leg).
    It does not prove CPI implementation; the separate Agave test exercises that.
    """
    if not s.live:
        return None
    h, f = s.h, s.f
    if op == "refund":
        if s.now >= DR or not 0 < amount <= f or s.merchant < amount:
            return None
        legs, f = [("merchant", "payer", amount)], f - amount
    else:
        if not s.vault or h <= 0 or s.balance < h:
            return None
        if op == "capture":
            if s.now >= DC or not 0 < amount <= h:
                return None
            legs = [("balance", "merchant", amount)]
            h, f = h - amount, f + amount
            if release and h:
                legs.append(("balance", "payer", h))
                h = 0
        elif op == "void" or (op == "reclaim" and s.now >= DC):
            legs, h = [("balance", "payer", h)], 0
        else:
            return None
    if 0 < fail_leg <= len(legs):
        return None
    balances = {name: getattr(s, name) for name in ("payer", "merchant", "balance")}
    for source, destination, value in legs:
        balances[source] -= value
        balances[destination] += value
    return replace(s, h=h, f=f, **balances)


def close_vault(s, recipient="sponsor", frozen=False):
    # Classic Token allows closing an empty frozen account. H remains authoritative.
    if not s.live or not s.vault or s.h or s.balance or recipient != "sponsor":
        return None
    return replace(s, vault=False, sol_returned=s.sol_returned + VAULT_DEPOSIT)


def close_payment(s, recipient="sponsor"):
    if (not s.live or s.h or (s.f and s.now < DR) or s.slot <= UNTIL_SLOT
            or s.vault or recipient != "sponsor"):
        return None
    return replace(s, live=False, sol_returned=s.sol_returned + PAYMENT_DEPOSIT)


def sweep_surplus(s, recipient="payer", frozen=False):
    if not s.live or not s.vault or s.h or not s.balance or frozen or recipient != "payer":
        return None
    return replace(s, payer=s.payer + s.balance, balance=0)


def projection(s):
    return None if s is None else (s.h, s.f, s.payer, s.merchant, s.balance)


def money_actions():
    yield "void", 0, False
    yield "reclaim", 0, False
    for amount in range(1, MAXIMUM + 2):  # Includes overdrawn/over-refund attempts.
        yield "capture", amount, False
        yield "capture", amount, True
        yield "refund", amount, False


def check_state(s):
    assert 0 <= s.h and 0 <= s.f and s.h + s.f <= MAXIMUM
    assert s.balance >= s.h
    assert s.payer >= 0 and s.merchant >= 0
    assert s.payer + s.merchant + s.balance == INITIAL_TOKENS + int(s.donated)
    assert s.vault or s.balance == 0
    assert s.authorizations <= 1, "a retired identity was authorized twice"
    locked = PAYMENT_DEPOSIT * s.live + VAULT_DEPOSIT * s.vault
    assert locked + s.sol_returned == s.sol_supplied
    if s.authorizations and not s.live:
        assert s.h == 0 and (s.f == 0 or s.now >= DR)
        assert s.slot > UNTIL_SLOT and not s.vault


def explore():
    start = State()
    seen, queue = {start}, deque([start])
    edges = comparisons = closed = failures = 0
    while queue:
        s = queue.popleft()
        check_state(s)
        successors = [authorize(s), close_vault(s), close_payment(s), sweep_surplus(s)]
        if s.slot < UNTIL_SLOT + 1:
            successors.append(replace(s, slot=s.slot + 1))
        if s.now < DR + 1:
            successors.append(replace(s, now=s.now + 1))
        if s.live and not s.donated:
            # A donor can recreate a closed ATA. Its additional rent is a gift to
            # the recorded recipient while Payment still exists, never a bounty.
            successors.append(replace(s, donated=True, vault=True, balance=s.balance + 1,
                                      sol_supplied=s.sol_supplied
                                      + (0 if s.vault else VAULT_DEPOSIT)))
        for op, amount, release in money_actions():
            result = monetary(s, op, amount, release)
            successors.append(result)
            if s.authorizations:
                # The arithmetic reference keeps both accounts. After deletion, the
                # account would still exist but all monetary operations must fail.
                reference = replace(s, live=True, vault=True)
                expected = monetary(reference, op, amount, release)
                assert projection(result) == projection(expected), (s, op, amount)
                comparisons += 1
            if result is not None:
                assert monetary(s, op, amount, release, fail_leg=1) is None
                failures += 1
                if op == "capture" and release and amount < s.h:
                    assert monetary(s, op, amount, release, fail_leg=2) is None
                    failures += 1
        if s.authorizations and not s.live:
            closed += 1
            assert authorize(s) is None
        for candidate in successors:
            if candidate is None:
                continue
            edges += 1
            check_state(candidate)
            if candidate not in seen:
                seen.add(candidate)
                queue.append(candidate)
    assert closed > 0 and comparisons > 0 and failures > 0
    return {"states": len(seen), "accepted_edges": edges,
            "reference_monetary_comparisons": comparisons, "closed_states": closed,
            "abstract_failed_transfer_checks": failures}


def counterexamples_and_boundaries():
    funded = authorize(State())
    assert funded is not None
    captured = monetary(funded, "capture", 1, True)
    assert captured is not None
    empty = close_vault(captured)
    assert empty is not None
    # Removing the vault does not remove the merchant-funded refund path.
    assert monetary(empty, "refund", 1) is not None
    assert close_payment(replace(empty, slot=UNTIL_SLOT + 1)) is None
    assert close_payment(replace(empty, slot=UNTIL_SLOT + 1, now=DR)) is not None
    # F=0 alone is insufficient: a hold still supports a later capture/refund.
    assert funded.f == 0 and funded.h > 0
    assert close_payment(replace(funded, slot=UNTIL_SLOT + 1)) is None
    assert monetary(funded, "capture", 1) is not None
    voided = monetary(funded, "void")
    assert voided is not None
    drained = close_vault(voided)
    assert drained is not None
    # <= on authorize and >= on close would overlap at the boundary.
    at_end = replace(drained, slot=UNTIL_SLOT)
    assert close_payment(at_end) is None
    naive_deleted = replace(at_end, live=False)
    assert authorize(naive_deleted) is not None  # Counterexample to early deletion.
    assert authorize(replace(naive_deleted, slot=UNTIL_SLOT + 1)) is None
    # Bind the expiry to the address. Passing a later expiry at the old address
    # must fail even when that later expiry passes the admission window.
    def identity(expiry, bind_expiry=True):
        base = ("v2", "payer", "salt")
        return (*base, expiry) if bind_expiry else base

    def admits_at(address, expiry, slot, bind_expiry=True):
        return address == identity(expiry, bind_expiry) and in_window(slot, expiry)

    old_identity = identity(UNTIL_SLOT)
    new_expiry = UNTIL_SLOT + 2
    assert not admits_at(old_identity, new_expiry, UNTIL_SLOT + 1)
    assert admits_at(identity(UNTIL_SLOT, False), new_expiry, UNTIL_SLOT + 1, False)
    # A current absent account cannot distinguish never-opened from closed.
    never_opened = replace(State(), now=DR, slot=UNTIL_SLOT + 1)
    closed = close_payment(replace(drained, now=DR, slot=UNTIL_SLOT + 1))
    assert closed is not None and not never_opened.live and not closed.live
    assert never_opened.authorizations != closed.authorizations
    # The fixed sponsor receives SOL; cleanup's caller cannot redirect it.
    assert close_vault(voided, recipient="attacker") is None
    assert close_payment(replace(drained, slot=UNTIL_SLOT + 1), recipient="attacker") is None
    dust = replace(voided, balance=1, donated=True)
    assert close_vault(dust) is None
    assert sweep_surplus(dust, recipient="attacker") is None
    assert sweep_surplus(dust, frozen=True) is None
    swept = sweep_surplus(dust)
    assert swept is not None and close_vault(swept) is not None
    assert close_vault(voided, frozen=True) is not None
    # Expiry validity uses checked subtraction, not a wrapping addition.
    assert not in_window(U64_MAX, U64_MAX)  # No representable cleanup slot.
    assert not in_window(U64_MAX - MAX_AHEAD, U64_MAX)
    assert in_window(U64_MAX - MAX_AHEAD - 1, U64_MAX - 1)
    assert not in_window(U64_MAX - MAX_AHEAD - 2, U64_MAX - 1)
    assert not in_window(U64_MAX, U64_MAX - 1)
    assert not in_window(0, U64_MAX + 1)
    # Increasing a future quoting limit cannot reopen a past absolute expiry.
    for cap in (0, 1, MAX_AHEAD, U64_MAX):
        assert not in_window(UNTIL_SLOT + 1, UNTIL_SLOT, cap)
    return ["premature-close-replay", "missing-expiry-seed", "live-hold-with-zero-F",
            "live-refund-after-vault-close", "absence-is-ambiguous",
            "fixed-rent-and-surplus-recipients", "dust-and-frozen-vault",
            "u64-and-expiry-boundaries", "future-window-change"]


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Run without Python optimization: assertions are the model checks.")
    print(json.dumps({"scope": "bounded abstract model; not on-chain implementation",
                      **explore(), "checks": counterexamples_and_boundaries()}, indent=2))
