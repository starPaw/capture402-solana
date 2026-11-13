//! Fixed identities and full balance/state assertions make CU comparisons repeatable.
use super::*;

fn audit_record(
    f: &Fixture,
    case: u64,
    operation: &str,
    meta: &litesvm::types::TransactionMetadata,
) {
    let bump = |owner: &Pubkey| {
        Pubkey::find_program_address(
            &[
                owner.as_ref(),
                spl_token_interface::id().as_ref(),
                f.mint.as_ref(),
            ],
            &spl_associated_token_account_interface::program::id(),
        )
        .1
    };
    println!(
        "AUDIT,{case},{operation},{},{},{},{},{}",
        meta.compute_units_consumed,
        payment_address(&ID, &f.payer.pubkey(), &f.salt, E).1,
        bump(&f.payment),
        bump(&f.payer.pubkey()),
        bump(&f.server.pubkey())
    );
    // Measured v2 bounds for these 128 fixed identities on the locked LiteSVM mainnet profile,
    // including Token CPI costs. They are regression limits, not transaction quotes.
    let ceiling = match operation {
        "authorize_new_vault" => 82_000,
        "authorize_existing_vault" => 73_000,
        "capture_40" | "capture_100_release_zero" => 41_000,
        "capture_40_release_60" => 46_000,
        "void_remaining_60" => 28_000,
        "reclaim_remaining_60" => 27_500,
        "refund_10" => 26_000,
        _ => panic!("unmeasured operation"),
    };
    assert!(
        meta.compute_units_consumed <= ceiling,
        "CU regression in {operation}, identity {case}: {} > {ceiling}",
        meta.compute_units_consumed
    );
    if case == 0 {
        for line in &meta.logs {
            println!("AUDIT_LOG|{operation}|{line}");
        }
    }
}

#[test]
fn compute_distribution() {
    println!(
        "AUDIT,case,operation,compute_units,payment_bump,vault_bump,payer_ata_bump,server_ata_bump"
    );
    for case in 0..128 {
        let mut role = 0u8;
        let mut f = Fixture::with_keypairs(|| {
            role += 1;
            let mut seed = [role; 32];
            seed[..8].copy_from_slice(&u64::to_le_bytes(case));
            Keypair::new_from_array(seed)
        });
        let fresh = f.svm.clone();
        let ix = f.authorize();
        let meta = f.send(&[ix], Some(0)).unwrap();
        f.check(100, 0, 0, 900, 0);
        audit_record(&f, case, "authorize_new_vault", &meta);
        let funded = f.svm.clone();

        let ix = f.capture(40, false, 100, 0);
        let meta = f.send(&[ix], Some(1)).unwrap();
        f.check(60, 40, 40, 900, 0);
        audit_record(&f, case, "capture_40", &meta);
        let partial = f.svm.clone();

        let ix = f.refund(10, 60, 40);
        let meta = f.send(&[ix], Some(1)).unwrap();
        f.check(60, 30, 30, 910, 0);
        audit_record(&f, case, "refund_10", &meta);

        f.svm = partial.clone();
        let ix = f.void(60, 40);
        let meta = f.send(&[ix], Some(1)).unwrap();
        f.check(0, 40, 40, 960, 0);
        audit_record(&f, case, "void_remaining_60", &meta);

        f.svm = partial;
        f.time(DC);
        let ix = f.reclaim();
        let meta = f.send(&[ix], Some(0)).unwrap();
        f.check(0, 40, 40, 960, 0);
        audit_record(&f, case, "reclaim_remaining_60", &meta);

        f.svm = funded.clone();
        let ix = f.capture(40, true, 100, 0);
        let meta = f.send(&[ix], Some(1)).unwrap();
        f.check(0, 40, 40, 960, 0);
        audit_record(&f, case, "capture_40_release_60", &meta);

        f.svm = funded;
        let ix = f.capture(100, true, 100, 0);
        let meta = f.send(&[ix], Some(1)).unwrap();
        f.check(0, 100, 100, 900, 0);
        audit_record(&f, case, "capture_100_release_zero", &meta);

        f.svm = fresh;
        let ix = create_ata(&f.sponsor.pubkey(), &f.payment, &f.mint);
        f.send(&[ix], None).unwrap();
        let ix = f.authorize();
        let meta = f.send(&[ix], Some(0)).unwrap();
        f.check(100, 0, 0, 900, 0);
        audit_record(&f, case, "authorize_existing_vault", &meta);
    }
}
