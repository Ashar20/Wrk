//! Wrk escrow.
//!
//! A buyer posts a task and funds a vault that belongs to that task alone. Contributors record each take on-chain
//! as pending, which reserves its payout. Only the task's validator can then accept a take (releasing exactly the
//! per-take amount from the vault to the contributor) or reject it (releasing the reservation). The validator can
//! never move more than one per-take amount per accepted take, never to itself, and never twice for the same take.
//! After the deadline the buyer takes back whatever isn't reserved. If the validator disappears, the buyer can
//! expire stale pending takes after a grace period so funds are never stuck.
//!
//! What this does NOT make trustless: whether a take deserves acceptance is the validator's judgement.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("8swdg4fKWMoqhcNLW4CS9hLdararEUKbjA8yB5Z3n9Qd");

pub const MAX_SCORE_BPS: u16 = 10_000;
/// A buyer may not set a grace period longer than this, so a task can't lock funds for years.
pub const MAX_GRACE_SECS: i64 = 90 * 24 * 60 * 60;

#[program]
pub mod wrk_escrow {
    use super::*;

    /// Opens a task and its empty vault. `bounty_id` is the SHA-256 of the task's public id.
    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        bounty_id: [u8; 32],
        validator: Pubkey,
        per_episode: u64,
        max_episodes: u32,
        deadline: i64,
        grace_secs: i64,
    ) -> Result<()> {
        require!(per_episode > 0, EscrowError::InvalidAmount);
        require!(max_episodes > 0, EscrowError::InvalidCount);
        require!(deadline > Clock::get()?.unix_timestamp, EscrowError::DeadlineInPast);
        require!((0..=MAX_GRACE_SECS).contains(&grace_secs), EscrowError::InvalidGrace);

        let b = &mut ctx.accounts.bounty;
        b.buyer = ctx.accounts.buyer.key();
        b.validator = validator;
        b.mint = ctx.accounts.mint.key();
        b.vault = ctx.accounts.vault.key();
        b.bounty_id = bounty_id;
        b.per_episode = per_episode;
        b.max_episodes = max_episodes;
        b.deadline = deadline;
        b.grace_secs = grace_secs;
        b.pending = 0;
        b.accepted = 0;
        b.bump = ctx.bumps.bounty;
        Ok(())
    }

    /// Anyone can add tokens to a task's vault; the buyer normally does.
    pub fn fund_bounty(ctx: Context<FundBounty>, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )
    }

    /// Records a take as pending and reserves its payout. Fails if the vault can't cover every pending take.
    pub fn submit_episode(ctx: Context<SubmitEpisode>, episode_id: [u8; 32], manifest_hash: [u8; 32]) -> Result<()> {
        record_take(
            &mut ctx.accounts.bounty, &mut ctx.accounts.episode, &ctx.accounts.vault,
            ctx.accounts.contributor.key(), episode_id, manifest_hash, ctx.bumps.episode,
        )
    }

    /// The same record, made by the task's validator on a contributor's behalf. The contributor signs nothing:
    /// they proved who they are when they signed in, and only the validator can accept a take or pay anyone anyway.
    pub fn submit_episode_for(ctx: Context<SubmitEpisodeFor>, episode_id: [u8; 32], manifest_hash: [u8; 32], contributor: Pubkey) -> Result<()> {
        record_take(
            &mut ctx.accounts.bounty, &mut ctx.accounts.episode, &ctx.accounts.vault,
            contributor, episode_id, manifest_hash, ctx.bumps.episode,
        )
    }

    /// Validator only. Pays the contributor exactly `per_episode` from the vault.
    pub fn accept_episode(ctx: Context<DecideEpisode>, score_bps: u16) -> Result<()> {
        require!(score_bps <= MAX_SCORE_BPS, EscrowError::InvalidScore);
        require!(ctx.accounts.episode.status == EpisodeStatus::Pending, EscrowError::NotPending);

        let amount = ctx.accounts.bounty.per_episode;
        require!(ctx.accounts.vault.amount >= amount, EscrowError::Underfunded);

        let buyer = ctx.accounts.bounty.buyer;
        let id = ctx.accounts.bounty.bounty_id;
        let bump = [ctx.accounts.bounty.bump];
        let seeds: &[&[u8]] = &[b"bounty", buyer.as_ref(), id.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.contributor_token.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        let b = &mut ctx.accounts.bounty;
        b.pending = b.pending.checked_sub(1).ok_or(EscrowError::Overflow)?;
        b.accepted = b.accepted.checked_add(1).ok_or(EscrowError::Overflow)?;
        let e = &mut ctx.accounts.episode;
        e.status = EpisodeStatus::Accepted;
        e.score_bps = score_bps;

        emit!(EpisodeDecided { bounty: b.key(), episode: e.key(), accepted: true, score_bps, paid: amount });
        Ok(())
    }

    /// Validator only. Refuses the take and frees its reservation. Nothing is paid.
    pub fn reject_episode(ctx: Context<RejectEpisode>, score_bps: u16) -> Result<()> {
        require!(score_bps <= MAX_SCORE_BPS, EscrowError::InvalidScore);
        require!(ctx.accounts.episode.status == EpisodeStatus::Pending, EscrowError::NotPending);

        let b = &mut ctx.accounts.bounty;
        b.pending = b.pending.checked_sub(1).ok_or(EscrowError::Overflow)?;
        let e = &mut ctx.accounts.episode;
        e.status = EpisodeStatus::Rejected;
        e.score_bps = score_bps;

        emit!(EpisodeDecided { bounty: b.key(), episode: e.key(), accepted: false, score_bps, paid: 0 });
        Ok(())
    }

    /// Buyer only, after the deadline plus the grace period: gives up on a take the validator never decided, so its
    /// reservation can't lock funds forever.
    pub fn expire_episode(ctx: Context<ExpireEpisode>) -> Result<()> {
        require!(ctx.accounts.episode.status == EpisodeStatus::Pending, EscrowError::NotPending);
        let b = &mut ctx.accounts.bounty;
        let ready_at = b.deadline.checked_add(b.grace_secs).ok_or(EscrowError::Overflow)?;
        require!(Clock::get()?.unix_timestamp > ready_at, EscrowError::TooEarly);

        b.pending = b.pending.checked_sub(1).ok_or(EscrowError::Overflow)?;
        ctx.accounts.episode.status = EpisodeStatus::Expired;
        Ok(())
    }

    /// Buyer only, after the deadline: takes back everything not reserved for a pending take.
    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let b = &ctx.accounts.bounty;
        require!(Clock::get()?.unix_timestamp > b.deadline, EscrowError::TooEarly);

        let reserved = (b.pending as u64).checked_mul(b.per_episode).ok_or(EscrowError::Overflow)?;
        let refundable = ctx.accounts.vault.amount.saturating_sub(reserved);
        require!(refundable > 0, EscrowError::NothingToRefund);

        let buyer = b.buyer;
        let id = b.bounty_id;
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[b"bounty", buyer.as_ref(), id.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                &[seeds],
            ),
            refundable,
        )
    }
}

// ---- accounts ------------------------------------------------------------------------------------------------------

fn record_take<'info>(
    b: &mut Account<'info, Bounty>,
    e: &mut Account<'info, Episode>,
    vault: &Account<'info, TokenAccount>,
    contributor: Pubkey,
    episode_id: [u8; 32],
    manifest_hash: [u8; 32],
    bump: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= b.deadline, EscrowError::BountyExpired);

    let committed = (b.accepted as u64).checked_add(b.pending as u64).ok_or(EscrowError::Overflow)?;
    require!(committed < b.max_episodes as u64, EscrowError::BountyFull);

    let reserved = (b.pending as u64).checked_add(1).ok_or(EscrowError::Overflow)?
        .checked_mul(b.per_episode).ok_or(EscrowError::Overflow)?;
    require!(vault.amount >= reserved, EscrowError::Underfunded);

    b.pending = b.pending.checked_add(1).ok_or(EscrowError::Overflow)?;

    e.bounty = b.key();
    e.contributor = contributor;
    e.episode_id = episode_id;
    e.manifest_hash = manifest_hash;
    e.status = EpisodeStatus::Pending;
    e.score_bps = 0;
    e.submitted_at = now;
    e.bump = bump;

    emit!(EpisodeSubmitted { bounty: b.key(), episode: e.key(), contributor, manifest_hash });
    Ok(())
}

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 32])]
pub struct CreateBounty<'info> {
    /// Pays rent and fees. May be the buyer, or a sponsor.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Owns the task and its refund rights.
    pub buyer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init, payer = payer, space = 8 + Bounty::INIT_SPACE,
        seeds = [b"bounty", buyer.key().as_ref(), bounty_id.as_ref()], bump
    )]
    pub bounty: Account<'info, Bounty>,
    #[account(
        init, payer = payer, seeds = [b"vault", bounty.key().as_ref()], bump,
        token::mint = mint, token::authority = bounty
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundBounty<'info> {
    pub funder: Signer<'info>,
    pub bounty: Account<'info, Bounty>,
    #[account(mut, address = bounty.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = bounty.mint, token::authority = funder)]
    pub funder_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(episode_id: [u8; 32])]
pub struct SubmitEpisode<'info> {
    /// Pays rent for the episode record and the fee. A sponsor in practice, so contributors need no SOL.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The contributor, who signs to own this take.
    pub contributor: Signer<'info>,
    #[account(mut)]
    pub bounty: Account<'info, Bounty>,
    #[account(address = bounty.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = payer, space = 8 + Episode::INIT_SPACE,
        seeds = [b"episode", bounty.key().as_ref(), episode_id.as_ref()], bump
    )]
    pub episode: Account<'info, Episode>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(episode_id: [u8; 32])]
pub struct SubmitEpisodeFor<'info> {
    /// The task's validator: pays rent and fees, and vouches for whose take this is.
    #[account(mut)]
    pub validator: Signer<'info>,
    #[account(mut, has_one = validator)]
    pub bounty: Account<'info, Bounty>,
    #[account(address = bounty.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = validator, space = 8 + Episode::INIT_SPACE,
        seeds = [b"episode", bounty.key().as_ref(), episode_id.as_ref()], bump
    )]
    pub episode: Account<'info, Episode>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DecideEpisode<'info> {
    /// The task's validator. Also pays to create the contributor's token account if it doesn't exist yet.
    #[account(mut)]
    pub validator: Signer<'info>,
    #[account(mut, has_one = validator, has_one = mint)]
    pub bounty: Account<'info, Bounty>,
    pub mint: Account<'info, Mint>,
    #[account(mut, address = bounty.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut, has_one = bounty,
        seeds = [b"episode", bounty.key().as_ref(), episode.episode_id.as_ref()], bump = episode.bump
    )]
    pub episode: Account<'info, Episode>,
    /// CHECK: pinned to the contributor recorded on the episode.
    #[account(address = episode.contributor)]
    pub contributor: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = validator,
        associated_token::mint = mint, associated_token::authority = contributor
    )]
    pub contributor_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RejectEpisode<'info> {
    pub validator: Signer<'info>,
    #[account(mut, has_one = validator)]
    pub bounty: Account<'info, Bounty>,
    #[account(
        mut, has_one = bounty,
        seeds = [b"episode", bounty.key().as_ref(), episode.episode_id.as_ref()], bump = episode.bump
    )]
    pub episode: Account<'info, Episode>,
}

#[derive(Accounts)]
pub struct ExpireEpisode<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer)]
    pub bounty: Account<'info, Bounty>,
    #[account(
        mut, has_one = bounty,
        seeds = [b"episode", bounty.key().as_ref(), episode.episode_id.as_ref()], bump = episode.bump
    )]
    pub episode: Account<'info, Episode>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    pub buyer: Signer<'info>,
    #[account(has_one = buyer)]
    pub bounty: Account<'info, Bounty>,
    #[account(mut, address = bounty.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = bounty.mint, token::authority = buyer)]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---- state ---------------------------------------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub buyer: Pubkey,
    pub validator: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    /// SHA-256 of the task's public id.
    pub bounty_id: [u8; 32],
    pub per_episode: u64,
    pub max_episodes: u32,
    /// Takes submitted and awaiting the validator; each reserves `per_episode` in the vault.
    pub pending: u32,
    pub accepted: u32,
    pub deadline: i64,
    pub grace_secs: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EpisodeStatus {
    Pending,
    Accepted,
    Rejected,
    Expired,
}

#[account]
#[derive(InitSpace)]
pub struct Episode {
    pub bounty: Pubkey,
    pub contributor: Pubkey,
    /// SHA-256 of the episode's public id.
    pub episode_id: [u8; 32],
    /// The manifest's own hash: the commitment to the exact bytes the contributor uploaded.
    pub manifest_hash: [u8; 32],
    pub status: EpisodeStatus,
    pub score_bps: u16,
    pub submitted_at: i64,
    pub bump: u8,
}

#[event]
pub struct EpisodeSubmitted {
    pub bounty: Pubkey,
    pub episode: Pubkey,
    pub contributor: Pubkey,
    pub manifest_hash: [u8; 32],
}

#[event]
pub struct EpisodeDecided {
    pub bounty: Pubkey,
    pub episode: Pubkey,
    pub accepted: bool,
    pub score_bps: u16,
    pub paid: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("The amount must be greater than zero.")]
    InvalidAmount,
    #[msg("The task must ask for at least one take.")]
    InvalidCount,
    #[msg("The deadline must be in the future.")]
    DeadlineInPast,
    #[msg("The grace period is out of range.")]
    InvalidGrace,
    #[msg("The score must be between 0 and 10,000 basis points.")]
    InvalidScore,
    #[msg("This task's deadline has passed.")]
    BountyExpired,
    #[msg("This task already has all the takes it asked for.")]
    BountyFull,
    #[msg("The task's vault doesn't hold enough to cover another take.")]
    Underfunded,
    #[msg("This take has already been decided.")]
    NotPending,
    #[msg("It's too early to do that.")]
    TooEarly,
    #[msg("There is nothing to refund.")]
    NothingToRefund,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
