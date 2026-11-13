//! Adversarial lifecycle tests execute the sole source-built v2 SBF program.
use litesvm::{types::TransactionResult, LiteSVM};
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_clock::Clock;
use solana_instruction::{AccountMeta as Meta, Instruction};
use solana_keypair::Keypair;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_system_interface::{instruction as system, program as system_program};
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_interface::state::{Account as Token, AccountState, Mint};
use svm_auth_capture::{self as protocol, Payment};

const DC: i64 = 1_100;
const DR: i64 = 1_200;
const E: u64 = 20;

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    spl_associated_token_account_interface::address::get_associated_token_address_with_program_id(
        owner,
        mint,
        &spl_token_interface::id(),
    )
}

struct Fixture {
    svm: LiteSVM,
    id: Pubkey,
    payer: Keypair,
    sponsor: Keypair,
    server: Keypair,
    cleaner: Keypair,
    mint: Pubkey,
    source: Pubkey,
    receiver: Pubkey,
    payment: Pubkey,
    vault: Pubkey,
    salt: [u8; 32],
    expiry: u64,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let id = protocol::ID;
        svm.add_program_from_file(id, "target/deploy/svm_auth_capture.so")
            .unwrap();
        let payer = Keypair::new();
        let sponsor = Keypair::new();
        let server = Keypair::new();
        let cleaner = Keypair::new();
        for key in [&payer, &sponsor, &server, &cleaner] {
            svm.airdrop(&key.pubkey(), 10_000_000_000).unwrap();
        }
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: COption::Some(payer.pubkey()),
                supply: 1_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: COption::Some(payer.pubkey()),
            },
            &mut data,
        )
        .unwrap();
        svm.set_account(
            mint,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: spl_token_interface::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let source = ata(&payer.pubkey(), &mint);
        let receiver = ata(&server.pubkey(), &mint);
        for (key, owner, amount) in [
            (source, payer.pubkey(), 1_000),
            (receiver, server.pubkey(), 0),
        ] {
            let mut data = vec![0; Token::LEN];
            Token::pack(
                Token {
                    mint,
                    owner,
                    amount,
                    delegate: COption::None,
                    state: AccountState::Initialized,
                    is_native: COption::None,
                    delegated_amount: 0,
                    close_authority: COption::None,
                },
                &mut data,
            )
            .unwrap();
            svm.set_account(
                key,
                Account {
                    lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: spl_token_interface::id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        }
        let salt = [9; 32];
        let payment = protocol::payment_address(&id, &payer.pubkey(), &salt, E).0;
        let vault = ata(&payment, &mint);
        let mut f = Self {
            svm,
            id,
            payer,
            sponsor,
            server,
            cleaner,
            mint,
            source,
            receiver,
            payment,
            vault,
            salt,
            expiry: E,
        };
        f.clock(10, 1_000);
        f
    }

    fn clock(&mut self, slot: u64, now: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.slot = slot;
        c.unix_timestamp = now;
        self.svm.set_sysvar(&c);
    }
    fn ix(&self, data: Vec<u8>, accounts: Vec<Meta>) -> Instruction {
        Instruction {
            program_id: self.id,
            accounts,
            data,
        }
    }
    fn auth(&self) -> Instruction {
        self.ix(
            protocol::authorize_data(self.salt, 100, DC, DR, self.expiry),
            vec![
                Meta::new(self.payer.pubkey(), true),
                Meta::new_readonly(self.server.pubkey(), false),
                Meta::new(self.payment, false),
                Meta::new_readonly(self.mint, false),
                Meta::new(self.source, false),
                Meta::new(self.vault, false),
                Meta::new(self.sponsor.pubkey(), true),
                Meta::new_readonly(system_program::id(), false),
                Meta::new_readonly(spl_token_interface::id(), false),
                Meta::new_readonly(spl_associated_token_account_interface::program::id(), false),
            ],
        )
    }
    fn capture(&self, amount: u64, release: bool, h: u64, f: u64) -> Instruction {
        self.ix(
            protocol::capture_data(amount, release, h, f),
            vec![
                Meta::new_readonly(self.server.pubkey(), true),
                Meta::new(self.payment, false),
                Meta::new_readonly(self.mint, false),
                Meta::new(self.vault, false),
                Meta::new(self.receiver, false),
                Meta::new(self.source, false),
                Meta::new_readonly(spl_token_interface::id(), false),
            ],
        )
    }
    fn void(&self, h: u64, f: u64) -> Instruction {
        self.ix(
            protocol::void_data(h, f),
            vec![
                Meta::new_readonly(self.server.pubkey(), true),
                Meta::new(self.payment, false),
                Meta::new_readonly(self.mint, false),
                Meta::new(self.vault, false),
                Meta::new(self.source, false),
                Meta::new_readonly(spl_token_interface::id(), false),
            ],
        )
    }
    fn refund(&self, amount: u64, h: u64, f: u64) -> Instruction {
        let mut ix = self.void(h, f);
        ix.data = protocol::refund_data(amount, h, f);
        ix.accounts[3].pubkey = self.receiver;
        ix
    }
    fn reclaim(&self) -> Instruction {
        let mut ix = self.void(0, 0);
        ix.data = vec![1];
        ix.accounts[0].pubkey = self.payer.pubkey();
        ix
    }
    fn cleanup(&self, tag: u8) -> Instruction {
        let mut accounts = vec![
            Meta::new_readonly(self.payment, false),
            Meta::new_readonly(self.mint, false),
            Meta::new(self.vault, false),
            Meta::new(
                if tag == 6 {
                    self.source
                } else {
                    self.sponsor.pubkey()
                },
                false,
            ),
        ];
        if tag == 7 {
            accounts[0].is_writable = true;
            accounts[2].is_writable = false;
        } else {
            accounts.push(Meta::new_readonly(spl_token_interface::id(), false));
        }
        self.ix(vec![tag], accounts)
    }
    fn retired(&self) -> Instruction {
        self.ix(
            protocol::recover_retired_data(self.salt, self.expiry),
            vec![
                Meta::new(self.payer.pubkey(), false),
                Meta::new(self.payment, false),
                Meta::new_readonly(self.mint, false),
                Meta::new(self.vault, false),
                Meta::new(self.source, false),
                Meta::new_readonly(system_program::id(), false),
                Meta::new_readonly(spl_token_interface::id(), false),
            ],
        )
    }
    fn create_vault(&self) -> Instruction {
        spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(
            &self.cleaner.pubkey(), &self.payment, &self.mint, &spl_token_interface::id())
    }
    #[allow(clippy::result_large_err)]
    fn send(&mut self, ix: &[Instruction], parties: &[u8]) -> TransactionResult {
        self.svm.expire_blockhash();
        let mut signers = vec![&self.cleaner];
        for role in parties {
            signers.push(match role {
                0 => &self.payer,
                1 => &self.server,
                2 => &self.sponsor,
                _ => panic!(),
            });
        }
        self.svm
            .send_transaction(Transaction::new_signed_with_payer(
                ix,
                Some(&self.cleaner.pubkey()),
                &signers,
                self.svm.latest_blockhash(),
            ))
    }
    fn open(&mut self) {
        self.send(&[self.auth()], &[0, 2]).unwrap();
    }
    fn terminal(&mut self) {
        self.open();
        self.send(&[self.void(100, 0)], &[1]).unwrap();
    }
    fn close(&mut self) {
        let clock = self.svm.get_sysvar::<Clock>();
        self.clock(clock.slot.max(self.expiry + 1), clock.unix_timestamp);
        self.send(&[self.cleanup(5), self.cleanup(7)], &[]).unwrap();
    }
    fn logical(&self) -> Payment {
        let a = self.svm.get_account(&self.payment).unwrap();
        Payment::decode(&a.data).unwrap()
    }

    fn amount(&self, key: Pubkey) -> u64 {
        Token::unpack(&self.svm.get_account(&key).unwrap().data)
            .unwrap()
            .amount
    }
    fn balance(&self, key: Pubkey) -> u64 {
        self.svm.get_balance(&key).unwrap_or(0)
    }
    fn snapshot(&self) -> Vec<Option<Account>> {
        [
            self.payment,
            self.vault,
            self.source,
            self.receiver,
            self.mint,
            self.payer.pubkey(),
            self.sponsor.pubkey(),
            self.server.pubkey(),
        ]
        .map(|key| self.svm.get_account(&key))
        .to_vec()
    }
    fn fails(&mut self, ix: &[Instruction], parties: &[u8]) {
        let before = self.snapshot();
        let result = self.send(ix, parties).expect_err("must reject in SBF");
        assert!(
            matches!(result.err, TransactionError::InstructionError(..)),
            "{:?}",
            result
        );
        assert_eq!(
            before,
            self.snapshot(),
            "failed transaction must retain every claim and deposit"
        );
    }
    fn edit_token(&mut self, key: Pubkey, edit: impl FnOnce(&mut Token)) {
        let mut a = self.svm.get_account(&key).unwrap();
        let mut token = Token::unpack(&a.data).unwrap();
        edit(&mut token);
        Token::pack(token, &mut a.data).unwrap();
        self.svm.set_account(key, a).unwrap();
    }
    fn dust(&mut self, amount: u64) {
        self.send(
            &[spl_token_interface::instruction::transfer_checked(
                &spl_token_interface::id(),
                &self.source,
                &self.mint,
                &self.vault,
                &self.payer.pubkey(),
                &[],
                amount,
                6,
            )
            .unwrap()],
            &[0],
        )
        .unwrap();
    }
}

#[test]
fn closure_refunds_actual_funder_not_fee_payer_and_is_permissionless() {
    let mut f = Fixture::new();
    let sponsor = f.balance(f.sponsor.pubkey());
    f.terminal();
    let deposits = f.balance(f.payment) + f.balance(f.vault);
    assert_eq!(sponsor - f.balance(f.sponsor.pubkey()), deposits);
    let state = Payment::decode(&f.svm.get_account(&f.payment).unwrap().data).unwrap();
    assert_eq!(state.rent_refund_recipient, f.sponsor.pubkey());
    f.close();
    assert_eq!(f.balance(f.sponsor.pubkey()), sponsor);
    assert!(f.svm.get_account(&f.payment).is_none());
    assert!(f.svm.get_account(&f.vault).is_none());
    // A concurrent closer cannot double-credit the stored sponsor.
    f.fails(&[f.cleanup(5)], &[]);
    f.fails(&[f.cleanup(7)], &[]);
}

#[test]
fn expiry_boundaries_and_u64_do_not_reopen_identity() {
    for slot in [E - 1, E] {
        let mut f = Fixture::new();
        f.clock(slot, 1_000);
        f.terminal();
        f.fails(&[f.auth()], &[0, 2]);
        f.send(&[f.cleanup(5)], &[]).unwrap();
        f.fails(&[f.cleanup(7)], &[]);
        f.clock(E + 1, 1_000);
        f.send(&[f.cleanup(7)], &[]).unwrap();
        f.fails(&[f.auth()], &[0, 2]);
    }
    for (slot, expiry, valid) in [
        (E + 1, E, false),
        (0, 1500, true),
        (0, 1501, false),
        (u64::MAX - 2, u64::MAX - 1, true),
        (u64::MAX - 1, u64::MAX, false),
        (u64::MAX, 0, false),
        (0, u64::MAX, false),
    ] {
        let mut f = Fixture::new();
        f.expiry = expiry;
        f.payment = protocol::payment_address(&f.id, &f.payer.pubkey(), &f.salt, expiry).0;
        f.vault = ata(&f.payment, &f.mint);
        f.clock(slot, 1_000);
        if valid {
            f.open();
        } else {
            f.fails(&[f.auth()], &[0, 2]);
        }
    }
}

#[test]
fn alternate_bump_and_v1_namespace_cannot_initialize_v2_state() {
    let mut f = Fixture::new();
    let canonical_bump = protocol::payment_address(&f.id, &f.payer.pubkey(), &f.salt, f.expiry).1;
    let alternate = (0..=u8::MAX)
        .filter(|b| *b != canonical_bump)
        .find_map(|b| {
            Pubkey::create_program_address(
                &[
                    protocol::SEED,
                    f.payer.pubkey().as_ref(),
                    &f.salt,
                    &f.expiry.to_le_bytes(),
                    &[b],
                ],
                &f.id,
            )
            .ok()
        })
        .unwrap();
    for address in [
        alternate,
        Pubkey::find_program_address(
            &[b"auth-capture-v1", f.payer.pubkey().as_ref(), &f.salt],
            &f.id,
        )
        .0,
    ] {
        f.payment = address;
        f.vault = ata(&address, &f.mint);
        f.fails(&[f.auth()], &[0, 2]);
    }
}

#[test]
fn payer_can_fund_v2_but_unsigned_or_non_system_funder_cannot_select_recipient() {
    let mut f = Fixture::new();
    let mut unsigned = f.auth();
    unsigned.accounts[6].is_signer = false;
    f.fails(&[unsigned], &[0]);
    let mut sponsor_account = f.svm.get_account(&f.sponsor.pubkey()).unwrap();
    sponsor_account.owner = Pubkey::new_unique();
    f.svm
        .set_account(f.sponsor.pubkey(), sponsor_account)
        .unwrap();
    f.fails(&[f.auth()], &[0, 2]);
    let before = f.balance(f.payer.pubkey());
    let mut self_funded = f.auth();
    self_funded.accounts[6].pubkey = f.payer.pubkey();
    f.send(&[self_funded], &[0]).unwrap();
    f.send(&[f.void(100, 0)], &[1]).unwrap();
    f.clock(E + 1, 1_000);
    let mut vault_close = f.cleanup(5);
    vault_close.accounts[3].pubkey = f.payer.pubkey();
    let mut payment_close = f.cleanup(7);
    payment_close.accounts[3].pubkey = f.payer.pubkey();
    f.send(&[vault_close, payment_close], &[]).unwrap();
    assert_eq!(f.balance(f.payer.pubkey()), before);
}

#[test]
fn same_transaction_refunding_cannot_revive_or_reauthorize() {
    let mut f = Fixture::new();
    f.terminal();
    f.clock(E + 1, 1_000);
    let gift = system::transfer(&f.cleaner.pubkey(), &f.payment, 1_000_000);
    f.fails(
        &[f.cleanup(5), f.cleanup(7), gift.clone(), f.auth()],
        &[0, 2],
    );
    // Closing then refunding SOL succeeds only as a zero-data system account.
    f.send(&[f.cleanup(5), f.cleanup(7), gift], &[]).unwrap();
    let a = f.svm.get_account(&f.payment).unwrap();
    assert_eq!(a.owner, system_program::id());
    assert!(a.data.is_empty());
    assert_eq!(a.lamports, 1_000_000);
    f.fails(&[f.auth()], &[0, 2]);
    f.fails(&[f.refund(1, 0, 1)], &[1]);
    let mut fresh_expiry_old_address = f.auth();
    fresh_expiry_old_address.data = protocol::authorize_data(f.salt, 100, DC, DR, E + 100);
    f.fails(&[fresh_expiry_old_address], &[0, 2]);
    let mut old_expiry_new_address = f.auth();
    old_expiry_new_address.accounts[2].pubkey =
        protocol::payment_address(&f.id, &f.payer.pubkey(), &f.salt, E + 100).0;
    f.fails(&[old_expiry_new_address], &[0, 2]);
}

#[test]
fn positive_hold_is_never_closable_even_with_zero_refundable_and_expired_terms() {
    let mut f = Fixture::new();
    f.open();
    f.clock(E + 1, DR + 1);
    for op in [5, 6, 7] {
        f.fails(&[f.cleanup(op)], &[]);
    }
    f.fails(&[f.retired()], &[]);
    f.send(&[f.reclaim()], &[0]).unwrap();
    f.close();
    assert_eq!(f.amount(f.source), 1_000);
}

#[test]
fn refunds_survive_vault_close_and_payment_close_obeys_exact_dr() {
    let mut f = Fixture::new();
    f.open();
    f.send(&[f.capture(40, true, 100, 0)], &[1]).unwrap();
    f.send(&[f.cleanup(5)], &[]).unwrap();
    f.clock(E + 1, DR - 1);
    f.fails(&[f.cleanup(7)], &[]);
    f.send(&[f.refund(10, 0, 40)], &[1]).unwrap();
    assert_eq!(f.logical().refundable, 30);
    assert_eq!(f.amount(f.source), 970);
    f.fails(&[f.cleanup(7)], &[]);
    f.clock(E + 1, DR);
    f.fails(&[f.refund(1, 0, 30)], &[1]);
    f.send(&[f.cleanup(7)], &[]).unwrap();
    assert_eq!(f.amount(f.receiver), 30);
}

#[test]
fn full_refund_allows_early_payment_close_but_never_replenishes_hold() {
    let mut f = Fixture::new();
    f.open();
    f.send(&[f.capture(40, true, 100, 0)], &[1]).unwrap();
    f.send(&[f.cleanup(5)], &[]).unwrap();
    f.send(&[f.refund(40, 0, 40)], &[1]).unwrap();
    assert_eq!((f.logical().held, f.logical().refundable), (0, 0));
    f.fails(&[f.capture(1, false, 0, 0)], &[1]);
    f.clock(E + 1, 1_000);
    f.send(&[f.cleanup(7)], &[]).unwrap();
}

#[test]
fn dust_and_recreated_vault_cannot_destroy_claims_or_redirect_surplus() {
    let mut f = Fixture::new();
    f.terminal();
    f.dust(7);
    f.clock(E + 1, 1_000);
    f.fails(&[f.cleanup(5)], &[]);
    f.fails(&[f.cleanup(7)], &[]);
    let mut stolen = f.cleanup(6);
    stolen.accounts[3].pubkey = f.receiver;
    f.fails(&[stolen], &[]);
    let before = f.logical();
    f.send(&[f.cleanup(6), f.cleanup(5)], &[]).unwrap();
    assert_eq!(f.logical(), before);
    assert_eq!(f.amount(f.source), 1_000);
    f.send(&[f.create_vault()], &[]).unwrap();
    f.dust(2);
    f.fails(&[f.cleanup(7)], &[]);
    f.send(&[f.cleanup(6), f.cleanup(5), f.cleanup(7)], &[])
        .unwrap();
}

#[test]
fn multi_payment_batch_is_atomic_and_recreated_vault_is_rechecked_in_same_transaction() {
    let mut f = Fixture::new();
    f.terminal();
    f.clock(E + 1, 1_000);
    f.fails(&[f.cleanup(5), f.create_vault(), f.cleanup(7)], &[]);
    let first = [f.cleanup(5), f.cleanup(7)];
    let first_key = f.payment;
    let first_state = f.svm.get_account(&first_key).unwrap();
    let sponsor = f.balance(f.sponsor.pubkey());
    let first_deposit = f.balance(f.payment) + f.balance(f.vault);
    f.salt = [10; 32];
    f.expiry = E + 10;
    f.payment = protocol::payment_address(&f.id, &f.payer.pubkey(), &f.salt, f.expiry).0;
    f.vault = ata(&f.payment, &f.mint);
    f.terminal();
    f.clock(f.expiry + 1, 1_000);
    f.dust(1);
    let batch = [
        first[0].clone(),
        first[1].clone(),
        f.cleanup(5),
        f.cleanup(7),
    ];
    f.fails(&batch, &[]);
    assert_eq!(f.svm.get_account(&first_key).unwrap(), first_state);
    f.send(&[f.cleanup(6)], &[]).unwrap();
    let second_deposit = f.balance(f.payment) + f.balance(f.vault);
    let before = f.balance(f.sponsor.pubkey());
    let meta = f.send(&batch, &[]).unwrap();
    assert_eq!(meta.fee, 5_000);
    assert_eq!(
        f.balance(f.sponsor.pubkey()),
        before + first_deposit + second_deposit
    );
    assert_eq!(f.balance(f.sponsor.pubkey()), sponsor + first_deposit);
    assert!(f.svm.get_account(&first_key).is_none());
    assert!(f.svm.get_account(&f.payment).is_none());
}

#[test]
fn empty_frozen_vault_closes_nonempty_frozen_sweep_rolls_back() {
    let mut f = Fixture::new();
    f.terminal();
    f.dust(1);
    f.edit_token(f.vault, |t| t.state = AccountState::Frozen);
    f.fails(&[f.cleanup(6), f.cleanup(5)], &[]);
    f.edit_token(f.vault, |t| t.state = AccountState::Initialized);
    f.edit_token(f.source, |t| t.state = AccountState::Frozen);
    f.fails(&[f.cleanup(6)], &[]);
    f.edit_token(f.source, |t| t.state = AccountState::Initialized);
    f.send(&[f.cleanup(6)], &[]).unwrap();
    f.edit_token(f.vault, |t| t.state = AccountState::Frozen);
    f.close();
}

#[test]
fn missing_payer_ata_blocks_sweep_without_consuming_state() {
    let mut f = Fixture::new();
    f.terminal();
    f.dust(1);
    f.svm.set_account(f.source, Account::default()).unwrap();
    f.fails(&[f.cleanup(6), f.cleanup(5)], &[]);
    f.send(&[spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(
        &f.cleaner.pubkey(), &f.payer.pubkey(), &f.mint, &spl_token_interface::id()), f.cleanup(6), f.cleanup(5)], &[]).unwrap();
    assert_eq!(f.amount(f.source), 1);
}

#[test]
fn prefunding_is_gift_and_system_owned_vault_requires_explicit_materialization() {
    let mut f = Fixture::new();
    f.send(
        &[
            system::transfer(&f.cleaner.pubkey(), &f.payment, 1_000_000),
            system::transfer(&f.cleaner.pubkey(), &f.vault, 1_000_000),
        ],
        &[],
    )
    .unwrap();
    let before = f.balance(f.sponsor.pubkey());
    f.terminal();
    f.close();
    assert_eq!(f.balance(f.sponsor.pubkey()), before + 2_000_000);
    let mut f = Fixture::new();
    f.terminal();
    f.send(&[f.cleanup(5)], &[]).unwrap();
    f.clock(E + 1, 1_000);
    f.send(
        &[system::transfer(&f.cleaner.pubkey(), &f.vault, 1_000_000)],
        &[],
    )
    .unwrap();
    f.fails(&[f.cleanup(7)], &[]);
    f.fails(&[f.cleanup(5)], &[]);
    f.send(&[f.create_vault(), f.cleanup(5), f.cleanup(7)], &[])
        .unwrap();
}

#[test]
fn recipient_owner_change_preserves_fixed_key_and_overflow_rejects_atomically() {
    let mut f = Fixture::new();
    f.terminal();
    let mut a = f.svm.get_account(&f.sponsor.pubkey()).unwrap();
    a.owner = Pubkey::new_unique();
    a.data = vec![7; 8];
    f.svm.set_account(f.sponsor.pubkey(), a.clone()).unwrap();
    f.close();
    assert!(f.balance(f.sponsor.pubkey()) > a.lamports);
    let mut f = Fixture::new();
    f.terminal();
    let mut a = f.svm.get_account(&f.sponsor.pubkey()).unwrap();
    a.lamports = u64::MAX;
    f.svm.set_account(f.sponsor.pubkey(), a).unwrap();
    f.fails(&[f.cleanup(5)], &[]);
}

#[test]
fn cleanup_checks_signer_independence_roles_aliases_programs_and_state_identity() {
    for tag in [5, 6, 7] {
        let mut f = Fixture::new();
        f.terminal();
        f.clock(E + 1, 1_000);
        if tag == 6 {
            f.dust(1);
        }
        if tag == 7 {
            f.send(&[f.cleanup(5)], &[]).unwrap();
        }
        for index in [0, 1, 2, 3] {
            let mut ix = f.cleanup(tag);
            ix.accounts[index].pubkey = f.cleaner.pubkey();
            f.fails(&[ix], &[]);
        }
        let writable_indices: &[usize] = if tag == 7 { &[0, 3] } else { &[2, 3] };
        for &index in writable_indices {
            let mut ix = f.cleanup(tag);
            ix.accounts[index].is_writable = false;
            f.fails(&[ix], &[]);
        }
        for index in 1..4 {
            let mut ix = f.cleanup(tag);
            ix.accounts[index].pubkey = f.payment;
            f.fails(&[ix], &[]);
        }
        if tag != 7 {
            let mut ix = f.cleanup(tag);
            ix.accounts[4].pubkey = system_program::id();
            f.fails(&[ix], &[]);
        }
        let mut ix = f.cleanup(tag);
        ix.data.push(0);
        f.fails(&[ix], &[]);
    }
    for change in 0..7 {
        let mut f = Fixture::new();
        f.terminal();
        let mut a = f.svm.get_account(&f.payment).unwrap();
        match change {
            0 => a.owner = system_program::id(),
            1 => a.data[0] ^= 1,
            2 => a.data[104] ^= 1,
            3 => a.data[176] ^= 1,
            4 => a.data[8] ^= 1,
            5 => a.data[72] ^= 1,
            _ => {
                a.data.pop();
            }
        }
        f.svm.set_account(f.payment, a).unwrap();
        f.fails(&[f.cleanup(5)], &[]);
    }
}

#[test]
fn unexpected_token_authorities_native_and_wrong_owner_fail_closed() {
    for change in 0..6 {
        let mut f = Fixture::new();
        f.terminal();
        let stranger = f.cleaner.pubkey();
        f.edit_token(f.vault, |t| match change {
            0 => t.delegate = COption::Some(stranger),
            1 => t.close_authority = COption::Some(stranger),
            2 => t.is_native = COption::Some(1),
            3 => t.owner = stranger,
            4 => t.mint = stranger,
            _ => t.state = AccountState::Uninitialized,
        });
        f.fails(&[f.cleanup(5)], &[]);
    }
    let mut f = Fixture::new();
    f.terminal();
    let mut a = f.svm.get_account(&f.vault).unwrap();
    a.owner = Pubkey::new_unique();
    f.svm.set_account(f.vault, a).unwrap();
    f.fails(&[f.cleanup(5)], &[]);
}

#[test]
fn retired_gifts_go_only_to_payer_without_recreating_payment() {
    let mut f = Fixture::new();
    f.terminal();
    f.close();
    let sponsor = f.balance(f.sponsor.pubkey());
    f.send(
        &[
            system::transfer(&f.cleaner.pubkey(), &f.payment, 1_000_000),
            f.create_vault(),
        ],
        &[],
    )
    .unwrap();
    f.dust(3);
    let payer = f.balance(f.payer.pubkey());
    let gift = f.balance(f.payment) + f.balance(f.vault);
    let mut steal = f.retired();
    steal.accounts[0].pubkey = f.cleaner.pubkey();
    f.fails(&[steal], &[]);
    f.edit_token(f.vault, |t| t.state = AccountState::Frozen);
    f.fails(&[f.retired()], &[]);
    f.edit_token(f.vault, |t| t.state = AccountState::Initialized);
    f.send(&[f.retired()], &[]).unwrap();
    assert_eq!(f.balance(f.payer.pubkey()), payer + gift);
    assert_eq!(f.amount(f.source), 1_000);
    assert_eq!(f.balance(f.sponsor.pubkey()), sponsor);
    assert!(f.svm.get_account(&f.payment).is_none());
    f.send(&[f.retired()], &[]).unwrap();
    f.fails(&[f.auth()], &[0, 2]);
}

#[test]
fn retired_recovery_cannot_touch_live_state_unexpired_identity_or_foreign_vault() {
    let mut f = Fixture::new();
    f.fails(&[f.retired()], &[]);
    f.terminal();
    f.clock(E + 1, 1_000);
    f.fails(&[f.retired()], &[]);
    f.close();
    let mut wrong = f.retired();
    wrong.accounts[3].pubkey = f.source;
    f.fails(&[wrong], &[]);
    let mut wrong = f.retired();
    wrong.accounts[4].pubkey = f.receiver;
    f.fails(&[wrong], &[]);
    f.send(
        &[system::transfer(&f.cleaner.pubkey(), &f.vault, 1_000_000)],
        &[],
    )
    .unwrap();
    f.fails(&[f.retired()], &[]);
    f.send(&[f.create_vault(), f.retired()], &[]).unwrap();
}

#[test]
fn obsolete_v1_wire_and_account_bytes_are_rejected() {
    let mut f = Fixture::new();
    let mut wrong = f.auth();
    wrong.data.truncate(67);
    wrong.data[1] = 1;
    f.fails(&[wrong], &[0, 2]);
    f.terminal();
    let bytes = f.svm.get_account(&f.payment).unwrap().data;
    assert_eq!(bytes.len(), protocol::PAYMENT_LEN);
    let mut obsolete = bytes[..176].to_vec();
    obsolete[..8].copy_from_slice(b"SACPAY01");
    assert!(Payment::decode(&obsolete).is_err());
}

#[test]
fn monetary_conservation_and_second_cpi_rollback_hold_across_expiries() {
    for amount in [1, 40, 99, 100] {
        for release in [false, true] {
            let mut outcomes = vec![];
            for expiry in [20, 21] {
                let mut f = Fixture::new();
                f.expiry = expiry;
                f.payment = protocol::payment_address(&f.id, &f.payer.pubkey(), &f.salt, expiry).0;
                f.vault = ata(&f.payment, &f.mint);
                f.open();
                if release && amount < 100 {
                    f.edit_token(f.source, |t| t.state = AccountState::Frozen);
                    f.fails(&[f.capture(amount, true, 100, 0)], &[1]);
                    f.edit_token(f.source, |t| t.state = AccountState::Initialized);
                }
                f.send(&[f.capture(amount, release, 100, 0)], &[1]).unwrap();
                f.fails(&[f.capture(1, false, 100, 0)], &[1]);
                let h = f.logical().held;
                f.send(&[f.refund(amount, h, amount)], &[1]).unwrap();
                if h > 0 {
                    f.clock(E + 1, DC);
                    f.fails(&[f.capture(1, false, h, 0)], &[1]);
                    f.send(&[f.reclaim()], &[0]).unwrap();
                }
                outcomes.push((
                    f.logical().held,
                    f.logical().refundable,
                    f.amount(f.source),
                    f.amount(f.receiver),
                    f.amount(f.vault),
                ));
            }
            assert_eq!(outcomes[0], outcomes[1]);
            assert_eq!(outcomes[0], (0, 0, 1_000, 0, 0));
        }
    }
}
