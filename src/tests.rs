use super::*;

#[test]
fn canonical_identity_never_caches_mutable_token_state() {
    let owner = Pubkey::new_from_array([7; 32]);
    let mint = Pubkey::new_from_array([8; 32]);
    let token_program = spl_token_interface::id();
    let key = spl_associated_token_account_interface::address::get_associated_token_address_with_program_id(
        &owner, &mint, &token_program,
    );
    let initial = TokenAccount {
        mint,
        owner,
        amount: 100,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = [0; TokenAccount::LEN];
    TokenAccount::pack(initial, &mut data).unwrap();
    let mut lamports = 10_000_000;
    let account = AccountInfo::new(
        &key,
        false,
        true,
        &mut lamports,
        &mut data,
        &token_program,
        false,
    );
    let view = CanonicalToken::new(&account, &owner, &mint, true).unwrap();
    assert_eq!(view.read(false).unwrap().amount, 100);
    let mut changed = initial;
    changed.amount = 77;
    TokenAccount::pack(changed, &mut account.try_borrow_mut_data().unwrap()).unwrap();
    assert_eq!(view.read(false).unwrap().amount, 77);
    for field in 0..7 {
        let mut changed = initial;
        match field {
            0 => changed.owner = ID,
            1 => changed.mint = ID,
            2 => changed.state = AccountState::Frozen,
            3 => changed.is_native = COption::Some(1),
            4 => changed.delegate = COption::Some(ID),
            5 => changed.close_authority = COption::Some(ID),
            _ => changed.state = AccountState::Uninitialized,
        }
        TokenAccount::pack(changed, &mut account.try_borrow_mut_data().unwrap()).unwrap();
        assert!(
            view.read(false).is_err(),
            "mutated field {field} must be rechecked"
        );
    }
}

#[test]
fn payment_v2_wire_is_exact_and_versions_never_cross_decode() {
    let state = Payment {
        payer: Pubkey::new_from_array([1; 32]),
        server: Pubkey::new_from_array([2; 32]),
        mint: Pubkey::new_from_array([3; 32]),
        salt: [4; 32],
        maximum: 100,
        capture_deadline: 1_100,
        refund_deadline: 1_200,
        held: 60,
        refundable: 40,
        authorize_until_slot: 0x0102030405060708,
        rent_refund_recipient: Pubkey::new_from_array([5; 32]),
    };
    let bytes = state.encode();
    assert_eq!(bytes.len(), 216);
    assert_eq!(&bytes[..8], b"SACPAY02");
    assert_eq!(&bytes[176..184], &[8, 7, 6, 5, 4, 3, 2, 1]);
    assert_eq!(&bytes[184..], &[5; 32]);
    assert_eq!(Payment::decode(&bytes).unwrap(), state);
    let mut obsolete = bytes[..176].to_vec();
    obsolete[..8].copy_from_slice(b"SACPAY01");
    assert!(Payment::decode(&obsolete).is_err());
    for len in [0, 175, 176, 215, 217] {
        assert!(Payment::decode(&vec![0; len]).is_err());
    }
    let data = authorize_data([4; 32], 100, 1_100, 1_200, state.authorize_until_slot);
    assert_eq!(&data[..3], &[0, 2, 0]);
    assert_eq!(data.len(), 75);
    assert_eq!(&data[67..], &bytes[176..184]);
}

#[test]
fn expiry_has_a_successor_and_never_wraps_or_revives() {
    for expiry in [0, 1, 1_500, 1_501, u64::MAX - 1] {
        assert!(authorization_window(expiry, expiry));
        assert!(!authorization_window(expiry + 1, expiry));
    }
    assert!(authorization_window(0, 1_500));
    assert!(!authorization_window(0, 1_501));
    assert!(!authorization_window(0, u64::MAX));
    assert!(!authorization_window(u64::MAX, u64::MAX));
}
