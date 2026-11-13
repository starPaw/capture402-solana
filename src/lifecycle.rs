//! V2 account closure and expired-identity gift recovery.
use super::*;

pub const MAX_FUTURE_AUTH_SLOTS: u64 = 1_500;

pub fn authorization_window(slot: u64, until: u64) -> bool {
    // A close must have a representable successor slot. Never create an
    // authorization whose expiry cannot be crossed, even at the u64 boundary.
    until < u64::MAX
        && until
            .checked_sub(slot)
            .is_some_and(|ahead| ahead <= MAX_FUTURE_AUTH_SLOTS)
}

/// Permissionless, expired-identity gift recovery; never proves an old outcome.
pub fn recover_retired_data(salt: [u8; 32], until: u64) -> Vec<u8> {
    let mut data = vec![8];
    data.extend_from_slice(&salt);
    data.extend_from_slice(&until.to_le_bytes());
    data
}

pub(super) fn signed(
    payer: &Pubkey,
    salt: &[u8; 32],
    until: u64,
    bump: u8,
    action: impl FnOnce(&[&[u8]]) -> ProgramResult,
) -> ProgramResult {
    action(&[SEED, payer.as_ref(), salt, &until.to_le_bytes(), &[bump]])
}

pub(super) fn cleanup(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data {
        [5] => close_empty_vault(program_id, a),
        [6] => sweep_surplus(program_id, a),
        [7] => close_payment(program_id, a),
        [8, ..] if data.len() == 41 => recover_retired(program_id, a, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn state(
    program_id: &Pubkey,
    payment: &AccountInfo,
    asset: &AccountInfo,
) -> Result<(Payment, u8), ProgramError> {
    require(
        payment.owner == program_id && !payment.executable,
        ProgramError::IncorrectProgramId,
    )?;
    let state = Payment::decode(&payment.try_borrow_data()?)?;
    let (address, bump) = state.address(program_id);
    require(payment.key == &address, ProgramError::InvalidSeeds)?;
    require(
        asset.key == &state.mint && state.held == 0,
        ProgramError::InvalidArgument,
    )?;
    mint(asset)?;
    Ok((state, bump))
}

fn recipient(state: &Payment, account: &AccountInfo) -> ProgramResult {
    writable(account)?;
    require(
        account.key == &state.rent_refund_recipient,
        ProgramError::InvalidArgument,
    )
}

fn absent(account: &AccountInfo) -> bool {
    account.owner == &system_program::id()
        && account.data_is_empty()
        && !account.executable
        && account.lamports() == 0
}

// An empty frozen classic account is closable. Do not apply transfer's frozen guard.
fn close_token<'a>(
    payment: &AccountInfo<'a>,
    vault: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    tokens: &AccountInfo<'a>,
    seeds: &[&[u8]],
) -> ProgramResult {
    writable(vault)?;
    writable(destination)?;
    distinct(&[payment.key, vault.key, destination.key, tokens.key])?;
    let expected = destination
        .lamports()
        .checked_add(vault.lamports())
        .ok_or(ProgramError::ArithmeticOverflow)?;
    invoke_signed(
        &spl_token_interface::instruction::close_account(
            &spl_token_interface::id(),
            vault.key,
            destination.key,
            payment.key,
            &[],
        )?,
        &[
            vault.clone(),
            destination.clone(),
            payment.clone(),
            tokens.clone(),
        ],
        &[seeds],
    )?;
    require(
        absent(vault) && destination.lamports() == expected,
        ProgramError::InvalidAccountData,
    )
}

/// [5]: Payment(r), mint(r), canonical vault(w), stored rent recipient(w), Token(r).
fn close_empty_vault(program_id: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [payment, asset, vault, destination, tokens] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    program(tokens, &spl_token_interface::id())?;
    let (state, bump) = state(program_id, payment, asset)?;
    recipient(&state, destination)?;
    distinct(&[
        payment.key,
        asset.key,
        vault.key,
        destination.key,
        tokens.key,
    ])?;
    let view = CanonicalToken::new(vault, payment.key, asset.key, true)?;
    require(
        view.read(true)?.amount == 0,
        ProgramError::InvalidAccountData,
    )?;
    state.signed(bump, |seeds| {
        close_token(payment, vault, destination, tokens, seeds)
    })
}

/// [6]: Payment(r), mint(r), canonical vault(w), stored payer ATA(w), Token(r).
fn sweep_surplus(program_id: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [payment, asset, vault, destination, tokens] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    program(tokens, &spl_token_interface::id())?;
    let (state, bump) = state(program_id, payment, asset)?;
    writable(vault)?;
    distinct(&[
        payment.key,
        asset.key,
        vault.key,
        destination.key,
        tokens.key,
    ])?;
    let view = CanonicalToken::new(vault, payment.key, asset.key, true)?;
    let amount = view.read(false)?.amount;
    // Unsolicited tokens belong to the payer; never modify H, F or refund terms.
    payout(
        bump,
        &state,
        payment,
        asset,
        &view,
        destination,
        tokens,
        &state.payer,
        amount,
    )
}

/// [7]: Payment(w), mint(r), canonical vault(r), stored rent recipient(w).
fn close_payment(program_id: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [payment, asset, vault, destination] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    writable(payment)?;
    let (state, _) = state(program_id, payment, asset)?;
    recipient(&state, destination)?;
    distinct(&[payment.key, asset.key, vault.key, destination.key])?;
    let clock = Clock::get()?;
    require(
        clock.slot > state.authorize_until_slot
            && (state.refundable == 0 || clock.unix_timestamp >= state.refund_deadline),
        ProgramError::InvalidArgument,
    )?;
    CanonicalToken::for_creation(vault, payment.key, asset.key, true)?;
    // A prefunded system ATA is not absent: materialize it using the ATA program
    // with an explicitly budgeted funder, then close it before deleting Payment.
    require(absent(vault), ProgramError::InvalidAccountData)?;
    let expected = destination
        .lamports()
        .checked_add(payment.lamports())
        .ok_or(ProgramError::ArithmeticOverflow)?;
    payment.try_borrow_mut_data()?.fill(0);
    payment.resize(0)?;
    **payment.try_borrow_mut_lamports()? = 0;
    **destination.try_borrow_mut_lamports()? = expected;
    payment.assign(&system_program::id());
    Ok(())
}

/// [8,salt:32,E:u64]: payer(w), retired Payment(w), mint(r), vault(w), payer ATA(w), System(r), Token(r).
/// All post-retirement gifts go to the fixed payer. No sponsor history is guessed.
fn recover_retired(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [payer, payment, asset, vault, destination, system, tokens] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    for account in [payer, payment, vault, destination] {
        writable(account)?;
    }
    program(system, &system_program::id())?;
    program(tokens, &spl_token_interface::id())?;
    distinct(&[
        payer.key,
        payment.key,
        asset.key,
        vault.key,
        destination.key,
        system.key,
        tokens.key,
    ])?;
    let salt = data[1..33].try_into().unwrap();
    let until = u64::from_le_bytes(data[33..41].try_into().unwrap());
    require(Clock::get()?.slot > until, ProgramError::InvalidArgument)?;
    let (address, bump) = payment_address(program_id, payer.key, &salt, until);
    require(payment.key == &address, ProgramError::InvalidSeeds)?;
    require(
        payment.owner == &system_program::id() && payment.data_is_empty() && !payment.executable,
        ProgramError::InvalidAccountData,
    )?;
    let decimals = mint(asset)?.decimals;
    let vault_view = CanonicalToken::for_creation(vault, payment.key, asset.key, true)?;
    let destination_view = CanonicalToken::for_creation(destination, payer.key, asset.key, false)?;
    signed(payer.key, &salt, until, bump, |seeds| {
        if !absent(vault) {
            let before = vault_view.read(true)?;
            if before.amount > 0 {
                let expected = destination_view
                    .read(false)?
                    .amount
                    .checked_add(before.amount)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                invoke_signed(
                    &spl_token_interface::instruction::transfer_checked(
                        &spl_token_interface::id(),
                        vault.key,
                        asset.key,
                        destination.key,
                        payment.key,
                        &[],
                        before.amount,
                        decimals,
                    )?,
                    &[
                        vault.clone(),
                        asset.clone(),
                        destination.clone(),
                        payment.clone(),
                        tokens.clone(),
                    ],
                    &[seeds],
                )?;
                require(
                    vault_view.read(false)?.amount == 0
                        && destination_view.read(false)?.amount == expected,
                    ProgramError::InvalidAccountData,
                )?;
            }
            close_token(payment, vault, payer, tokens, seeds)?;
        }
        let amount = payment.lamports();
        if amount > 0 {
            let expected = payer
                .lamports()
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            invoke_signed(
                &system_instruction::transfer(payment.key, payer.key, amount),
                &[payment.clone(), payer.clone(), system.clone()],
                &[seeds],
            )?;
            require(
                absent(payment) && payer.lamports() == expected,
                ProgramError::InvalidAccountData,
            )?;
        }
        Ok(())
    })
}
