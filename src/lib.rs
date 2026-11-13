//! V2 classic-SPL escrow with expiry-bound identity and recoverable account storage.
mod lifecycle;
#[cfg(test)]
mod tests;
pub use lifecycle::{authorization_window, recover_retired_data, MAX_FUTURE_AUTH_SLOTS};

use solana_account_info::AccountInfo;
use solana_address::Address as Pubkey;
use solana_clock::Clock;
use solana_cpi::{invoke, invoke_signed};
use solana_program_error::{ProgramError, ProgramResult};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_rent::Rent;
use solana_system_interface::{instruction as system_instruction, program as system_program};
use solana_sysvar::Sysvar;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

// Local harness identity only; no supported network or deployment is declared.
pub const ID: Pubkey = Pubkey::new_from_array([43; 32]);
pub const SEED: &[u8] = b"auth-capture-v2";
pub const DISCRIMINATOR: &[u8; 8] = b"SACPAY02";
pub const PAYMENT_LEN: usize = 216;

#[cfg(not(feature = "no-entrypoint"))]
solana_program_entrypoint::entrypoint!(process_instruction);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub payer: Pubkey,
    pub server: Pubkey,
    pub mint: Pubkey,
    pub salt: [u8; 32],
    pub maximum: u64,
    pub capture_deadline: i64,
    pub refund_deadline: i64,
    pub held: u64,
    pub refundable: u64,
    pub authorize_until_slot: u64,
    pub rent_refund_recipient: Pubkey,
}

impl Payment {
    const LEN: usize = PAYMENT_LEN;

    pub fn address(&self, program: &Pubkey) -> (Pubkey, u8) {
        payment_address(program, &self.payer, &self.salt, self.authorize_until_slot)
    }

    fn signed(&self, bump: u8, action: impl FnOnce(&[&[u8]]) -> ProgramResult) -> ProgramResult {
        lifecycle::signed(
            &self.payer,
            &self.salt,
            self.authorize_until_slot,
            bump,
            action,
        )
    }

    fn authorization(a: &[AccountInfo], data: &[u8], clock: &Clock) -> Result<Self, ProgramError> {
        require(
            data.len() == 75 && data[1] == 2 && data[2] == 0 && data[3..11] == [0; 8],
            ProgramError::InvalidInstructionData,
        )?;
        let expiry = u64::from_le_bytes(data[67..75].try_into().unwrap());
        require(
            authorization_window(clock.slot, expiry),
            ProgramError::InvalidArgument,
        )?;
        let funder = &a[6];
        // The immutable recipient is the explicit account-creation funder, not
        // the fee payer or whoever later sends a permissionless cleanup.
        require(
            funder.owner == &system_program::id() && funder.data_is_empty() && !funder.executable,
            ProgramError::InvalidAccountData,
        )?;
        distinct(&[
            funder.key, a[2].key, a[3].key, a[4].key, a[5].key, a[7].key, a[8].key, a[9].key,
        ])?;
        let maximum = u64::from_le_bytes(data[43..51].try_into().unwrap());
        let dc = i64::from_le_bytes(data[51..59].try_into().unwrap());
        let dr = i64::from_le_bytes(data[59..67].try_into().unwrap());
        require(
            maximum > 0 && dc > 0 && clock.unix_timestamp < dc && dc <= dr,
            ProgramError::InvalidArgument,
        )?;
        Ok(Self {
            payer: *a[0].key,
            server: *a[1].key,
            mint: *a[3].key,
            salt: data[11..43].try_into().unwrap(),
            maximum,
            capture_deadline: dc,
            refund_deadline: dr,
            held: maximum,
            refundable: 0,
            authorize_until_slot: expiry,
            rent_refund_recipient: *funder.key,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0; PAYMENT_LEN];
        self.write_into(&mut out).expect("fixed payment length");
        out
    }

    /// Write the exact v2 layout without a heap buffer.
    fn write_into(&self, out: &mut [u8]) -> ProgramResult {
        require(out.len() == PAYMENT_LEN, ProgramError::InvalidAccountData)?;
        out[..8].copy_from_slice(DISCRIMINATOR);
        out[8..40].copy_from_slice(self.payer.as_ref());
        out[40..72].copy_from_slice(self.server.as_ref());
        out[72..104].copy_from_slice(self.mint.as_ref());
        out[104..136].copy_from_slice(&self.salt);
        out[136..144].copy_from_slice(&self.maximum.to_le_bytes());
        out[144..152].copy_from_slice(&self.capture_deadline.to_le_bytes());
        out[152..160].copy_from_slice(&self.refund_deadline.to_le_bytes());
        out[160..168].copy_from_slice(&self.held.to_le_bytes());
        out[168..176].copy_from_slice(&self.refundable.to_le_bytes());
        out[176..184].copy_from_slice(&self.authorize_until_slot.to_le_bytes());
        out[184..216].copy_from_slice(self.rent_refund_recipient.as_ref());
        Ok(())
    }

    pub fn decode(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != PAYMENT_LEN || &data[..8] != DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let p = Self {
            payer: Pubkey::new_from_array(data[8..40].try_into().unwrap()),
            server: Pubkey::new_from_array(data[40..72].try_into().unwrap()),
            mint: Pubkey::new_from_array(data[72..104].try_into().unwrap()),
            salt: data[104..136].try_into().unwrap(),
            maximum: u64::from_le_bytes(data[136..144].try_into().unwrap()),
            capture_deadline: i64::from_le_bytes(data[144..152].try_into().unwrap()),
            refund_deadline: i64::from_le_bytes(data[152..160].try_into().unwrap()),
            held: u64::from_le_bytes(data[160..168].try_into().unwrap()),
            refundable: u64::from_le_bytes(data[168..176].try_into().unwrap()),
            authorize_until_slot: u64::from_le_bytes(data[176..184].try_into().unwrap()),
            rent_refund_recipient: Pubkey::new_from_array(data[184..216].try_into().unwrap()),
        };
        if p.authorize_until_slot == u64::MAX
            || p.payer == p.server
            || p.maximum == 0
            || p.capture_deadline <= 0
            || p.refund_deadline < p.capture_deadline
            || p.held
                .checked_add(p.refundable)
                .is_none_or(|sum| sum > p.maximum)
        {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(p)
    }
}

pub fn payment_address(
    program: &Pubkey,
    payer: &Pubkey,
    salt: &[u8; 32],
    until: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED, payer.as_ref(), salt, &until.to_le_bytes()], program)
}

/// Wire: authorize=0, version=2, escrow=0, fee=0:u64, salt:32, M:u64, Dc:i64, Dr:i64, E:u64.
/// Accounts: payer(s,w), server, payment(w), mint, payer ATA(w), vault(w),
/// rent funder(s,w), System, classic Token, ATA program.
pub fn authorize_data(salt: [u8; 32], maximum: u64, dc: i64, dr: i64, until: u64) -> Vec<u8> {
    let mut data = vec![0, 2, 0];
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&salt);
    data.extend_from_slice(&maximum.to_le_bytes());
    data.extend_from_slice(&dc.to_le_bytes());
    data.extend_from_slice(&dr.to_le_bytes());
    data.extend_from_slice(&until.to_le_bytes());
    data
}

/// Wire: capture=2, amount:u64, releaseRemainder:bool(0/1), expectedH:u64, expectedF:u64.
/// Accounts: server(s), payment(w), mint, vault(w), server ATA(w), payer ATA(w), classic Token.
/// The payer ATA is used only for a positive remainder release.
pub fn capture_data(
    amount: u64,
    release_remainder: bool,
    expected_h: u64,
    expected_f: u64,
) -> Vec<u8> {
    let mut data = vec![2];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(u8::from(release_remainder));
    data.extend_from_slice(&expected_h.to_le_bytes());
    data.extend_from_slice(&expected_f.to_le_bytes());
    data
}

/// Wire: void=3, expectedH:u64, expectedF:u64.
/// Accounts: server(s), payment(w), mint, vault(w), payer ATA(w), classic Token.
pub fn void_data(expected_h: u64, expected_f: u64) -> Vec<u8> {
    let mut data = vec![3];
    data.extend_from_slice(&expected_h.to_le_bytes());
    data.extend_from_slice(&expected_f.to_le_bytes());
    data
}

/// Wire: refund=4, amount:u64, expectedH:u64, expectedF:u64.
/// Accounts: server(s), payment(w), mint, server ATA(w), payer ATA(w), classic Token.
pub fn refund_data(amount: u64, expected_h: u64, expected_f: u64) -> Vec<u8> {
    let mut data = vec![4];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&expected_h.to_le_bytes());
    data.extend_from_slice(&expected_f.to_le_bytes());
    data
}

fn require(ok: bool, error: ProgramError) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(error)
    }
}

fn signer(account: &AccountInfo) -> ProgramResult {
    require(account.is_signer, ProgramError::MissingRequiredSignature)
}

fn writable(account: &AccountInfo) -> ProgramResult {
    require(account.is_writable, ProgramError::InvalidAccountData)
}

fn distinct(keys: &[&Pubkey]) -> ProgramResult {
    for (i, key) in keys.iter().enumerate() {
        require(!keys[..i].contains(key), ProgramError::InvalidArgument)?;
    }
    Ok(())
}

fn program(account: &AccountInfo, id: &Pubkey) -> ProgramResult {
    require(
        account.key == id && account.executable,
        ProgramError::IncorrectProgramId,
    )
}

fn mint(account: &AccountInfo) -> Result<Mint, ProgramError> {
    require(
        account.owner == &spl_token_interface::id(),
        ProgramError::IncorrectProgramId,
    )?;
    require(
        account.key != &spl_token_interface::native_mint::id(),
        ProgramError::InvalidArgument,
    )?;
    Mint::unpack(&account.try_borrow_data()?)
}

// Account addresses cannot change during an instruction. Cache only their canonical
// identity, never token data: every read (including after CPI) checks fresh account data.
struct CanonicalToken<'a, 'info> {
    account: &'a AccountInfo<'info>,
    owner: Pubkey,
    mint: Pubkey,
    vault: bool,
}

impl<'a, 'info> CanonicalToken<'a, 'info> {
    fn new(
        account: &'a AccountInfo<'info>,
        owner: &Pubkey,
        mint: &Pubkey,
        vault: bool,
    ) -> Result<Self, ProgramError> {
        require(
            account.owner == &spl_token_interface::id(),
            ProgramError::IncorrectProgramId,
        )?;
        Self::for_creation(account, owner, mint, vault)
    }

    // Authorization also validates the vault address before the ATA program creates it.
    // This does not establish a valid token account; read() must succeed after creation.
    fn for_creation(
        account: &'a AccountInfo<'info>,
        owner: &Pubkey,
        mint: &Pubkey,
        vault: bool,
    ) -> Result<Self, ProgramError> {
        require(
            account.key == &spl_associated_token_account_interface::address::get_associated_token_address_with_program_id(
                owner, mint, &spl_token_interface::id(),
            ),
            ProgramError::InvalidSeeds,
        )?;
        Ok(Self {
            account,
            owner: *owner,
            mint: *mint,
            vault,
        })
    }

    fn read(&self, allow_frozen: bool) -> Result<TokenAccount, ProgramError> {
        require(
            self.account.owner == &spl_token_interface::id(),
            ProgramError::IncorrectProgramId,
        )?;
        let state = TokenAccount::unpack(&self.account.try_borrow_data()?)?;
        require(
            state.owner == self.owner
                && state.mint == self.mint
                && (state.state == AccountState::Initialized
                    || (allow_frozen && state.state == AccountState::Frozen))
                && state.is_native == COption::None,
            ProgramError::InvalidAccountData,
        )?;
        if self.vault {
            require(
                state.delegate == COption::None && state.close_authority == COption::None,
                ProgramError::InvalidAccountData,
            )?;
        }
        Ok(state)
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(0) => authorize(program_id, accounts, data),
        Some(1) if data.len() == 1 => reclaim(program_id, accounts),
        Some(2) if data.len() == 26 && data[9] <= 1 => capture(program_id, accounts, data),
        Some(3) if data.len() == 17 => void(program_id, accounts, data),
        Some(4) if data.len() == 25 => refund(program_id, accounts, data),
        Some(5..=8) => lifecycle::cleanup(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn authorize(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    require(
        data.len() == 75 && data[1] == 2 && data[2] == 0 && data[3..11] == [0; 8],
        ProgramError::InvalidInstructionData,
    )?;
    let [payer, server, payment, asset, source, vault, funder, system, tokens, ata] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    signer(payer)?;
    signer(funder)?;
    for account in [payer, payment, source, vault, funder] {
        writable(account)?;
    }
    program(system, &system_program::id())?;
    program(tokens, &spl_token_interface::id())?;
    program(ata, &spl_associated_token_account_interface::program::id())?;
    distinct(&[
        payer.key,
        server.key,
        payment.key,
        asset.key,
        source.key,
        vault.key,
    ])?;
    let state = Payment::authorization(a, data, &Clock::get()?)?;
    let maximum = state.maximum;
    let (address, bump) = state.address(program_id);
    require(payment.key == &address, ProgramError::InvalidSeeds)?;
    // Only an unused system-owned, zero-data address may be initialized.
    require(
        payment.owner == &system_program::id() && payment.data_is_empty() && !payment.executable,
        ProgramError::AccountAlreadyInitialized,
    )?;
    let asset_state = mint(asset)?;
    let source_view = CanonicalToken::new(source, payer.key, asset.key, false)?;
    let before_source = source_view.read(false)?.amount;
    let vault_view = CanonicalToken::for_creation(vault, payment.key, asset.key, true)?;

    // allocate+assign handles unsolicited lamports, unlike create_account.
    let rent = Rent::get()?.minimum_balance(Payment::LEN);
    let top_up = rent.saturating_sub(payment.lamports());
    if top_up > 0 {
        invoke(
            &system_instruction::transfer(funder.key, payment.key, top_up),
            &[funder.clone(), payment.clone(), system.clone()],
        )?;
    }
    state.signed(bump, |seeds| {
        invoke_signed(
            &system_instruction::allocate(payment.key, Payment::LEN as u64),
            &[payment.clone(), system.clone()],
            &[seeds],
        )
    })?;
    state.signed(bump, |seeds| {
        invoke_signed(
            &system_instruction::assign(payment.key, program_id),
            &[payment.clone(), system.clone()],
            &[seeds],
        )
    })?;
    invoke(
        &spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(
            funder.key,
            payment.key,
            asset.key,
            &spl_token_interface::id(),
        ),
        &[
            funder.clone(),
            vault.clone(),
            payment.clone(),
            asset.clone(),
            system.clone(),
            tokens.clone(),
            ata.clone(),
        ],
    )?;
    let before_vault = vault_view.read(false)?.amount;
    let expected_source = before_source
        .checked_sub(maximum)
        .ok_or(ProgramError::InsufficientFunds)?;
    let expected_vault = before_vault
        .checked_add(maximum)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    invoke(
        &spl_token_interface::instruction::transfer_checked(
            &spl_token_interface::id(),
            source.key,
            asset.key,
            vault.key,
            payer.key,
            &[],
            maximum,
            asset_state.decimals,
        )?,
        &[
            source.clone(),
            asset.clone(),
            vault.clone(),
            payer.clone(),
            tokens.clone(),
        ],
    )?;
    require(
        source_view.read(false)?.amount == expected_source
            && vault_view.read(false)?.amount == expected_vault,
        ProgramError::InvalidAccountData,
    )?;
    state.write_into(&mut payment.try_borrow_mut_data()?)
}

/// Wire: [1]. Accounts: payer(s), payment(w), mint, vault(w), payer ATA(w), classic Token.
/// Missing payer ATA repair is an explicitly signed preceding ATA instruction in the same tx.
fn reclaim(program_id: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [payer, payment, asset, vault, destination, tokens] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    signer(payer)?;
    for account in [payment, vault, destination] {
        writable(account)?;
    }
    program(tokens, &spl_token_interface::id())?;
    require(
        payment.owner == program_id,
        ProgramError::IncorrectProgramId,
    )?;
    let mut state = Payment::decode(&payment.try_borrow_data()?)?;
    require(
        payer.key == &state.payer && asset.key == &state.mint,
        ProgramError::InvalidArgument,
    )?;
    let (address, bump) = state.address(program_id);
    require(payment.key == &address, ProgramError::InvalidSeeds)?;
    distinct(&[
        payer.key,
        payment.key,
        asset.key,
        vault.key,
        destination.key,
    ])?;
    require(
        Clock::get()?.unix_timestamp >= state.capture_deadline && state.held > 0,
        ProgramError::InvalidArgument,
    )?;
    let asset_state = mint(asset)?;
    let vault_view = CanonicalToken::new(vault, payment.key, asset.key, true)?;
    let before_vault = vault_view.read(false)?.amount;
    let destination_view = CanonicalToken::new(destination, payer.key, asset.key, false)?;
    let before_destination = destination_view.read(false)?.amount;
    let expected_vault = before_vault
        .checked_sub(state.held)
        .ok_or(ProgramError::InsufficientFunds)?;
    let expected_destination = before_destination
        .checked_add(state.held)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    state.signed(bump, |seeds| {
        invoke_signed(
            &spl_token_interface::instruction::transfer_checked(
                &spl_token_interface::id(),
                vault.key,
                asset.key,
                destination.key,
                payment.key,
                &[],
                state.held,
                asset_state.decimals,
            )?,
            &[
                vault.clone(),
                asset.clone(),
                destination.clone(),
                payment.clone(),
                tokens.clone(),
            ],
            &[seeds],
        )
    })?;
    require(
        vault_view.read(false)?.amount == expected_vault
            && destination_view.read(false)?.amount == expected_destination,
        ProgramError::InvalidAccountData,
    )?;
    state.held = 0;
    state.write_into(&mut payment.try_borrow_mut_data()?)
}

// Shared server guards enforce identity, authority, exact consent, and vault backing.
// No new lifecycle state or authority is introduced.
fn server_state<'a, 'info>(
    program_id: &Pubkey,
    server: &AccountInfo,
    payment: &AccountInfo,
    asset: &AccountInfo,
    vault: &'a AccountInfo<'info>,
    tokens: &AccountInfo,
    expected: &[u8],
) -> Result<(Payment, u8, CanonicalToken<'a, 'info>), ProgramError> {
    signer(server)?;
    writable(payment)?;
    writable(vault)?;
    program(tokens, &spl_token_interface::id())?;
    require(
        payment.owner == program_id,
        ProgramError::IncorrectProgramId,
    )?;
    let state = Payment::decode(&payment.try_borrow_data()?)?;
    require(
        server.key == &state.server && asset.key == &state.mint,
        ProgramError::InvalidArgument,
    )?;
    let (address, bump) = state.address(program_id);
    require(payment.key == &address, ProgramError::InvalidSeeds)?;
    require(
        state.held == u64::from_le_bytes(expected[..8].try_into().unwrap())
            && state.refundable == u64::from_le_bytes(expected[8..16].try_into().unwrap())
            && state.held > 0,
        ProgramError::InvalidArgument,
    )?;
    let vault_view = CanonicalToken::new(vault, payment.key, asset.key, true)?;
    require(
        vault_view.read(false)?.amount >= state.held,
        ProgramError::InsufficientFunds,
    )?;
    Ok((state, bump, vault_view))
}

// Frozen destinations retain valid identities: let Token reject the actual CPI.
// In capture+void this also exercises rollback after a successful server leg.
#[allow(clippy::too_many_arguments)] // Explicit CPI account roles and stored recipient/amount.
fn payout<'a>(
    bump: u8,
    state: &Payment,
    payment: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    vault_view: &CanonicalToken<'_, 'a>,
    destination: &AccountInfo<'a>,
    tokens: &AccountInfo<'a>,
    recipient: &Pubkey,
    amount: u64,
) -> ProgramResult {
    let vault = vault_view.account;
    require(amount > 0, ProgramError::InvalidArgument)?;
    writable(destination)?;
    let decimals = mint(asset)?.decimals;
    let before_vault = vault_view.read(false)?.amount;
    let destination_view = CanonicalToken::new(destination, recipient, asset.key, false)?;
    let before_destination = destination_view.read(true)?.amount;
    let expected_vault = before_vault
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    let expected_destination = before_destination
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    state.signed(bump, |seeds| {
        invoke_signed(
            &spl_token_interface::instruction::transfer_checked(
                &spl_token_interface::id(),
                vault.key,
                asset.key,
                destination.key,
                payment.key,
                &[],
                amount,
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
        )
    })?;
    require(
        vault_view.read(false)?.amount == expected_vault
            && destination_view.read(false)?.amount == expected_destination,
        ProgramError::InvalidAccountData,
    )
}

fn capture(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [server, payment, asset, vault, receiver, payer_ata, tokens] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (mut state, bump, vault_view) = server_state(
        program_id,
        server,
        payment,
        asset,
        vault,
        tokens,
        &data[10..],
    )?;
    distinct(&[
        server.key,
        payment.key,
        asset.key,
        vault.key,
        receiver.key,
        payer_ata.key,
    ])?;
    let amount = u64::from_le_bytes(data[1..9].try_into().unwrap());
    require(
        Clock::get()?.unix_timestamp < state.capture_deadline && amount > 0 && amount <= state.held,
        ProgramError::InvalidArgument,
    )?;
    let remainder = state
        .held
        .checked_sub(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let next_f = state
        .refundable
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    payout(
        bump,
        &state,
        payment,
        asset,
        &vault_view,
        receiver,
        tokens,
        &state.server,
        amount,
    )?;
    if data[9] == 1 && remainder > 0 {
        payout(
            bump,
            &state,
            payment,
            asset,
            &vault_view,
            payer_ata,
            tokens,
            &state.payer,
            remainder,
        )?;
    }
    state.held = if data[9] == 1 { 0 } else { remainder };
    state.refundable = next_f;
    state.write_into(&mut payment.try_borrow_mut_data()?)
}

fn void(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [server, payment, asset, vault, destination, tokens] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (mut state, bump, vault_view) = server_state(
        program_id,
        server,
        payment,
        asset,
        vault,
        tokens,
        &data[1..],
    )?;
    distinct(&[
        server.key,
        payment.key,
        asset.key,
        vault.key,
        destination.key,
    ])?;
    payout(
        bump,
        &state,
        payment,
        asset,
        &vault_view,
        destination,
        tokens,
        &state.payer,
        state.held,
    )?;
    state.held = 0;
    state.write_into(&mut payment.try_borrow_mut_data()?)
}

fn refund(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [server, payment, asset, source, destination, tokens] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    signer(server)?;
    for account in [payment, source, destination] {
        writable(account)?;
    }
    program(tokens, &spl_token_interface::id())?;
    require(
        payment.owner == program_id,
        ProgramError::IncorrectProgramId,
    )?;
    let mut state = Payment::decode(&payment.try_borrow_data()?)?;
    require(
        server.key == &state.server && asset.key == &state.mint,
        ProgramError::InvalidArgument,
    )?;
    require(
        payment.key == &state.address(program_id).0,
        ProgramError::InvalidSeeds,
    )?;
    distinct(&[
        server.key,
        payment.key,
        asset.key,
        source.key,
        destination.key,
    ])?;
    let amount = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let expected_h = u64::from_le_bytes(data[9..17].try_into().unwrap());
    let expected_f = u64::from_le_bytes(data[17..25].try_into().unwrap());
    require(
        state.held == expected_h
            && state.refundable == expected_f
            && Clock::get()?.unix_timestamp < state.refund_deadline
            && amount > 0
            && amount <= state.refundable,
        ProgramError::InvalidArgument,
    )?;
    let next_f = state
        .refundable
        .checked_sub(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let decimals = mint(asset)?.decimals;
    // A frozen canonical account retains its identity; the Token CPI rejects it.
    let source_view = CanonicalToken::new(source, server.key, asset.key, false)?;
    let before_source = source_view.read(true)?.amount;
    let destination_view = CanonicalToken::new(destination, &state.payer, asset.key, false)?;
    let before_destination = destination_view.read(true)?.amount;
    let expected_destination = before_destination
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    invoke(
        &spl_token_interface::instruction::transfer_checked(
            &spl_token_interface::id(),
            source.key,
            asset.key,
            destination.key,
            server.key,
            &[],
            amount,
            decimals,
        )?,
        &[
            source.clone(),
            asset.clone(),
            destination.clone(),
            server.clone(),
            tokens.clone(),
        ],
    )?;
    let expected_source = before_source
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    require(
        source_view.read(false)?.amount == expected_source
            && destination_view.read(false)?.amount == expected_destination,
        ProgramError::InvalidAccountData,
    )?;
    state.refundable = next_f;
    state.write_into(&mut payment.try_borrow_mut_data()?)
}
