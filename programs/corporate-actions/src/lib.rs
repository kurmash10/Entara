use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    non_transferable::NonTransferable, permanent_delegate::PermanentDelegate,
    BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint as PaymentMint, Token, TokenAccount as PaymentAccount, TransferChecked},
    token_2022::{self, Burn, FreezeAccount, MintTo, ThawAccount, Token2022},
    token_interface::{Mint, TokenAccount},
};

declare_id!("BQNmoaaGmwVE3DAgLRAuCXScXSvougAgLA7FoPUnCfMz");
pub const MAX_HOLDERS: usize = 8;

#[program]
pub mod corporate_actions {
    use super::*;
    pub fn create_bond(
        ctx: Context<CreateBond>,
        name: String,
        symbol: String,
        face_value: u64,
        coupon_bps: u16,
        payments_per_year: u8,
        period_seconds: i64,
        maturity: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            !name.is_empty() && name.len() <= 48 && !symbol.is_empty() && symbol.len() <= 12,
            ErrorCode::InvalidTerms
        );
        require!(
            face_value > 0
                && coupon_bps > 0
                && coupon_bps <= 10000
                && [1, 2, 4, 12].contains(&payments_per_year),
            ErrorCode::InvalidTerms
        );
        require!(period_seconds > 0 && maturity > now, ErrorCode::InvalidDate);
        require!(
            ctx.accounts.bond_mint.decimals == 0 && ctx.accounts.bond_mint.supply == 0,
            ErrorCode::InvalidMint
        );
        require!(
            ctx.accounts.payment_mint.decimals == 6,
            ErrorCode::InvalidMint
        );
        require!(
            ctx.accounts.payment_mint.mint_authority
                == anchor_lang::solana_program::program_option::COption::Some(
                    ctx.accounts.issuer.key()
                ),
            ErrorCode::InvalidMint
        );
        let key = ctx.accounts.bond.key();
        require!(
            ctx.accounts.bond_mint.mint_authority
                == anchor_lang::solana_program::program_option::COption::Some(key)
                && ctx.accounts.bond_mint.freeze_authority
                    == anchor_lang::solana_program::program_option::COption::Some(key),
            ErrorCode::InvalidMint
        );
        let mint_info = ctx.accounts.bond_mint.to_account_info();
        let data = mint_info.try_borrow_data()?;
        let extended =
            StateWithExtensions::<anchor_spl::token_2022::spl_token_2022::state::Mint>::unpack(
                &data,
            )?;
        extended
            .get_extension::<NonTransferable>()
            .map_err(|_| error!(ErrorCode::InvalidMint))?;
        let delegate = extended.get_extension::<PermanentDelegate>()?;
        require!(
            Option::<Pubkey>::from(delegate.delegate) == Some(key),
            ErrorCode::InvalidMint
        );
        drop(data);
        let bond = &mut ctx.accounts.bond;
        bond.issuer = ctx.accounts.issuer.key();
        bond.bond_mint = ctx.accounts.bond_mint.key();
        bond.payment_mint = ctx.accounts.payment_mint.key();
        bond.name = name;
        bond.symbol = symbol;
        bond.face_value = face_value;
        bond.coupon_bps = coupon_bps;
        bond.payments_per_year = payments_per_year;
        bond.period_seconds = period_seconds;
        bond.issued_at = now;
        bond.maturity = maturity;
        bond.bump = ctx.bumps.bond;
        Ok(())
    }

    pub fn add_holder(ctx: Context<AddHolder>, quantity: u64) -> Result<()> {
        let bond = &mut ctx.accounts.bond;
        require!(
            !bond.sealed && Clock::get()?.unix_timestamp < bond.maturity,
            ErrorCode::RegistrySealed
        );
        require!(
            quantity > 0 && (bond.holder_count as usize) < MAX_HOLDERS,
            ErrorCode::InvalidQuantity
        );
        require!(
            !bond.holders[..bond.holder_count as usize]
                .iter()
                .any(|h| h.wallet == ctx.accounts.holder.key()),
            ErrorCode::DuplicateHolder
        );
        let supply = bond
            .total_supply
            .checked_add(quantity)
            .ok_or(ErrorCode::Overflow)?;
        amount(supply as u128 * bond.face_value as u128)?;
        let issuer = bond.issuer;
        let mint = bond.bond_mint;
        let bump = [bond.bump];
        let seeds: &[&[u8]] = &[b"bond", issuer.as_ref(), mint.as_ref(), &bump];
        token_2022::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.bond_mint.to_account_info(),
                    to: ctx.accounts.holder_bonds.to_account_info(),
                    authority: bond.to_account_info(),
                },
                &[seeds],
            ),
            quantity,
        )?;
        token_2022::freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            FreezeAccount {
                account: ctx.accounts.holder_bonds.to_account_info(),
                mint: ctx.accounts.bond_mint.to_account_info(),
                authority: bond.to_account_info(),
            },
            &[seeds],
        ))?;
        let index = bond.holder_count as usize;
        bond.holders[index] = Holder {
            wallet: ctx.accounts.holder.key(),
            quantity,
            paid: 0,
        };
        bond.holder_count += 1;
        bond.total_supply = supply;
        bond.outstanding = supply;
        Ok(())
    }

    // kind: 0 coupon, 1 maturity redemption, 2 early redemption.
    pub fn announce(
        ctx: Context<Announce>,
        kind: u8,
        record_date: i64,
        target_quantity: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bond = &mut ctx.accounts.bond;
        require!(
            !bond.active && bond.outstanding > 0 && kind <= 2,
            ErrorCode::InvalidState
        );
        require!(record_date >= now, ErrorCode::InvalidDate);
        let coupon_index = bond
            .coupon_count
            .checked_add(1)
            .ok_or(ErrorCode::Overflow)?;
        if kind == 0 {
            let due = bond
                .period_seconds
                .checked_mul(coupon_index as i64)
                .and_then(|n| bond.issued_at.checked_add(n))
                .ok_or(ErrorCode::Overflow)?;
            require!(
                record_date >= due && record_date <= bond.maturity,
                ErrorCode::InvalidDate
            );
        } else if kind == 1 {
            require!(record_date >= bond.maturity, ErrorCode::InvalidDate);
        } else {
            require!(
                record_date < bond.maturity
                    && target_quantity > 0
                    && target_quantity <= bond.outstanding,
                ErrorCode::InvalidQuantity
            );
        }
        let action = &mut ctx.accounts.action;
        action.bond = bond.key();
        action.id = bond.next_action;
        action.kind = kind;
        action.record_date = record_date;
        action.coupon_index = coupon_index;
        action.target_quantity = if kind == 1 {
            bond.outstanding
        } else if kind == 2 {
            target_quantity
        } else {
            0
        };
        action.holder_count = bond.holder_count;
        bond.active = true;
        bond.sealed = true;
        bond.next_action = bond.next_action.checked_add(1).ok_or(ErrorCode::Overflow)?;
        Ok(())
    }

    pub fn take_snapshot(ctx: Context<TakeSnapshot>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bond = &ctx.accounts.bond;
        let action = &mut ctx.accounts.action;
        require!(
            bond.active && action.id + 1 == bond.next_action && action.status == 0,
            ErrorCode::InvalidState
        );
        require!(now >= action.record_date, ErrorCode::RecordDateNotReached);
        let count = bond.holder_count as usize;
        let mut quantities = [0u64; MAX_HOLDERS];
        for i in 0..count {
            quantities[i] = bond.holders[i].quantity;
        }
        let redeemed = if action.kind == 2 {
            apportion(&quantities, count, action.target_quantity)?
        } else {
            quantities
        };
        for i in 0..count {
            let value = if action.kind == 0 {
                coupon(
                    quantities[i],
                    bond.face_value,
                    bond.coupon_bps,
                    bond.payments_per_year,
                )?
            } else {
                amount(redeemed[i] as u128 * bond.face_value as u128)?
            };
            action.entries[i] = Entitlement {
                wallet: bond.holders[i].wallet,
                eligible_quantity: quantities[i],
                quantity: if action.kind == 0 { 0 } else { redeemed[i] },
                amount: value,
                settled: false,
            };
            action.total = action.total.checked_add(value).ok_or(ErrorCode::Overflow)?;
        }
        action.snapshot_at = now;
        action.status = 1;
        emit!(ActionSnapshot {
            action: action.key(),
            total: action.total,
            record_date: action.record_date,
            snapshot_at: now
        });
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, holder_index: u8) -> Result<()> {
        let bond = &mut ctx.accounts.bond;
        let action = &mut ctx.accounts.action;
        require!(
            bond.active && action.id + 1 == bond.next_action && action.status == 1,
            ErrorCode::InvalidState
        );
        require!(
            holder_index < action.holder_count,
            ErrorCode::InvalidQuantity
        );
        let index = holder_index as usize;
        let entry = action.entries[index];
        require!(!entry.settled, ErrorCode::AlreadySettled);
        require_keys_eq!(
            entry.wallet,
            ctx.accounts.holder.key(),
            ErrorCode::InvalidHolder
        );
        require_keys_eq!(
            entry.wallet,
            bond.holders[index].wallet,
            ErrorCode::InvalidHolder
        );
        require!(
            ctx.accounts.treasury.amount >= entry.amount,
            ErrorCode::InsufficientFunds
        );
        let issuer = bond.issuer;
        let mint = bond.bond_mint;
        let bump = [bond.bump];
        let seeds: &[&[u8]] = &[b"bond", issuer.as_ref(), mint.as_ref(), &bump];
        if entry.amount > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.treasury.to_account_info(),
                        mint: ctx.accounts.payment_mint.to_account_info(),
                        to: ctx.accounts.holder_payment.to_account_info(),
                        authority: bond.to_account_info(),
                    },
                    &[seeds],
                ),
                entry.amount,
                6,
            )?;
        }
        if entry.quantity > 0 {
            token_2022::thaw_account(CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                ThawAccount {
                    account: ctx.accounts.holder_bonds.to_account_info(),
                    mint: ctx.accounts.bond_mint.to_account_info(),
                    authority: bond.to_account_info(),
                },
                &[seeds],
            ))?;
            token_2022::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_2022_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.bond_mint.to_account_info(),
                        from: ctx.accounts.holder_bonds.to_account_info(),
                        authority: bond.to_account_info(),
                    },
                    &[seeds],
                ),
                entry.quantity,
            )?;
            token_2022::freeze_account(CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                FreezeAccount {
                    account: ctx.accounts.holder_bonds.to_account_info(),
                    mint: ctx.accounts.bond_mint.to_account_info(),
                    authority: bond.to_account_info(),
                },
                &[seeds],
            ))?;
            bond.holders[index].quantity = bond.holders[index]
                .quantity
                .checked_sub(entry.quantity)
                .ok_or(ErrorCode::Overflow)?;
            bond.outstanding = bond
                .outstanding
                .checked_sub(entry.quantity)
                .ok_or(ErrorCode::Overflow)?;
        }
        bond.holders[index].paid = bond.holders[index]
            .paid
            .checked_add(entry.amount)
            .ok_or(ErrorCode::Overflow)?;
        action.entries[index].settled = true;
        if action.entries[..action.holder_count as usize]
            .iter()
            .all(|e| e.settled)
        {
            action.status = 2;
            bond.active = false;
            if action.kind == 0 {
                bond.coupon_count = action.coupon_index;
            }
        }
        emit!(HolderSettled {
            action: action.key(),
            holder: entry.wallet,
            amount: entry.amount,
            quantity: entry.quantity
        });
        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let action = &mut ctx.accounts.action;
        let bond = &mut ctx.accounts.bond;
        require!(
            bond.active && action.id + 1 == bond.next_action && action.status <= 1,
            ErrorCode::InvalidState
        );
        require!(
            !action.entries[..action.holder_count as usize]
                .iter()
                .any(|e| e.settled),
            ErrorCode::AlreadySettled
        );
        action.status = 3;
        bond.active = false;
        Ok(())
    }
}

fn amount(n: u128) -> Result<u64> {
    u64::try_from(n).map_err(|_| error!(ErrorCode::Overflow))
}
fn coupon(quantity: u64, face: u64, bps: u16, frequency: u8) -> Result<u64> {
    let product = (quantity as u128)
        .checked_mul(face as u128)
        .and_then(|n| n.checked_mul(bps as u128))
        .ok_or(ErrorCode::Overflow)?;
    require!(frequency > 0, ErrorCode::InvalidTerms);
    amount(product / (10000 * frequency as u128))
}
fn apportion(
    quantities: &[u64; MAX_HOLDERS],
    count: usize,
    target: u64,
) -> Result<[u64; MAX_HOLDERS]> {
    let total: u128 = quantities[..count].iter().map(|q| *q as u128).sum();
    require!(
        total > 0 && target > 0 && target as u128 <= total,
        ErrorCode::InvalidQuantity
    );
    let mut shares = [0u64; MAX_HOLDERS];
    let mut remainder = [0u128; MAX_HOLDERS];
    let mut assigned = 0u64;
    for i in 0..count {
        let product = quantities[i] as u128 * target as u128;
        shares[i] = amount(product / total)?;
        remainder[i] = product % total;
        assigned += shares[i];
    }
    for _ in 0..(target - assigned) {
        let mut best = 0;
        for i in 1..count {
            if remainder[i] > remainder[best] {
                best = i;
            }
        }
        shares[best] += 1;
        remainder[best] = 0;
    }
    Ok(shares)
}

#[derive(Accounts)]
pub struct CreateBond<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(init, payer = issuer, space = 2048, seeds = [b"bond", issuer.key().as_ref(), bond_mint.key().as_ref()], bump)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(mint::token_program = token_2022_program)]
    pub bond_mint: InterfaceAccount<'info, Mint>,
    pub payment_mint: Account<'info, PaymentMint>,
    #[account(init, payer = issuer, associated_token::mint = payment_mint, associated_token::authority = bond)]
    pub treasury: Account<'info, PaymentAccount>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct AddHolder<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(mut, has_one = issuer, has_one = bond_mint, seeds = [b"bond", issuer.key().as_ref(), bond_mint.key().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    /// CHECK: wallet identity is stored in the registry; it does not authorize this instruction.
    pub holder: UncheckedAccount<'info>,
    #[account(mut, mint::token_program = token_2022_program)]
    pub bond_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = issuer, associated_token::mint = bond_mint, associated_token::authority = holder, associated_token::token_program = token_2022_program)]
    pub holder_bonds: InterfaceAccount<'info, TokenAccount>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Announce<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(mut, has_one = issuer)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(init, payer = issuer, space = 1024, seeds = [b"action", bond.key().as_ref(), &bond.next_action.to_le_bytes()], bump)]
    pub action: Box<Account<'info, CorporateAction>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct TakeSnapshot<'info> {
    pub bond: Box<Account<'info, Bond>>,
    #[account(mut, has_one = bond)]
    pub action: Box<Account<'info, CorporateAction>>,
}
#[derive(Accounts)]
pub struct Settle<'info> {
    pub issuer: Signer<'info>,
    #[account(mut, has_one = issuer, has_one = bond_mint, has_one = payment_mint)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(mut, has_one = bond)]
    pub action: Box<Account<'info, CorporateAction>>,
    /// CHECK: compared with the immutable snapshot entry before any CPI.
    pub holder: UncheckedAccount<'info>,
    #[account(mut, mint::token_program = token_2022_program)]
    pub bond_mint: InterfaceAccount<'info, Mint>,
    pub payment_mint: Account<'info, PaymentMint>,
    #[account(mut, associated_token::mint = payment_mint, associated_token::authority = bond)]
    pub treasury: Account<'info, PaymentAccount>,
    #[account(mut, associated_token::mint = bond_mint, associated_token::authority = holder, associated_token::token_program = token_2022_program)]
    pub holder_bonds: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = payment_mint, associated_token::authority = holder)]
    pub holder_payment: Account<'info, PaymentAccount>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}
#[derive(Accounts)]
pub struct Cancel<'info> {
    pub issuer: Signer<'info>,
    #[account(mut, has_one = issuer)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(mut, has_one = bond)]
    pub action: Box<Account<'info, CorporateAction>>,
}

#[account]
#[derive(Default)]
pub struct Bond {
    pub issuer: Pubkey,
    pub bond_mint: Pubkey,
    pub payment_mint: Pubkey,
    pub name: String,
    pub symbol: String,
    pub face_value: u64,
    pub coupon_bps: u16,
    pub payments_per_year: u8,
    pub issued_at: i64,
    pub maturity: i64,
    pub period_seconds: i64,
    pub total_supply: u64,
    pub outstanding: u64,
    pub sealed: bool,
    pub active: bool,
    pub coupon_count: u32,
    pub next_action: u64,
    pub holder_count: u8,
    pub bump: u8,
    pub holders: [Holder; MAX_HOLDERS],
}
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Default)]
pub struct Holder {
    pub wallet: Pubkey,
    pub quantity: u64,
    pub paid: u64,
}
#[account]
pub struct CorporateAction {
    pub bond: Pubkey,
    pub id: u64,
    pub kind: u8,
    pub status: u8,
    pub record_date: i64,
    pub snapshot_at: i64,
    pub target_quantity: u64,
    pub coupon_index: u32,
    pub holder_count: u8,
    pub total: u64,
    pub entries: [Entitlement; MAX_HOLDERS],
}
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Default)]
pub struct Entitlement {
    pub wallet: Pubkey,
    pub eligible_quantity: u64,
    pub quantity: u64,
    pub amount: u64,
    pub settled: bool,
}
#[event]
pub struct ActionSnapshot {
    pub action: Pubkey,
    pub total: u64,
    pub record_date: i64,
    pub snapshot_at: i64,
}
#[event]
pub struct HolderSettled {
    pub action: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub quantity: u64,
}
#[error_code]
pub enum ErrorCode {
    #[msg("Invalid bond terms")]
    InvalidTerms,
    #[msg("Invalid date or coupon period not due")]
    InvalidDate,
    #[msg("Invalid mint or mint authorities")]
    InvalidMint,
    #[msg("Holder registry is sealed")]
    RegistrySealed,
    #[msg("Invalid quantity or holder limit exceeded")]
    InvalidQuantity,
    #[msg("Holder already registered")]
    DuplicateHolder,
    #[msg("Amount exceeds supported range")]
    Overflow,
    #[msg("Action is not in the required state")]
    InvalidState,
    #[msg("Record date has not arrived")]
    RecordDateNotReached,
    #[msg("Entitlement already settled")]
    AlreadySettled,
    #[msg("Holder does not match snapshot")]
    InvalidHolder,
    #[msg("Insufficient mock USD in treasury")]
    InsufficientFunds,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coupon_example() {
        assert_eq!(coupon(10, 1_000_000_000, 1000, 2).unwrap(), 500_000_000);
    }
    #[test]
    fn allocation_preserves_principal() {
        assert_eq!(
            apportion(&[10, 20, 10, 0, 0, 0, 0, 0], 3, 10).unwrap(),
            [3, 5, 2, 0, 0, 0, 0, 0]
        );
        for a in 1..20 {
            for b in 1..20 {
                for target in 1..=a + b {
                    let result = apportion(&[a, b, 0, 0, 0, 0, 0, 0], 2, target).unwrap();
                    assert_eq!(result.iter().sum::<u64>(), target);
                    assert!(result[0] <= a && result[1] <= b);
                }
            }
        }
    }
    #[test]
    fn rejects_overflow() {
        assert!(coupon(u64::MAX, u64::MAX, 10000, 1).is_err());
    }
}
