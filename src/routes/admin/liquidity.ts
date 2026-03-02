import { Hono } from "hono";
import { db } from "../../db/prisma.js";
import { error, success } from "../../utils/response.js";
import { connection } from "../../turnkey/signer.js";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const liquidityRoutes = new Hono();

// =============================================================================
// Summary
// =============================================================================

// GET /liquidity/summary
liquidityRoutes.get("/summary", async (c) => {
  try {
    const [
      totalDeposits,
      totalWithdrawals,
      totalPositions,
      activePositions,
      totalRewardClaims,
      failedTransfers,
    ] = await Promise.all([
      db.liquidityDeposit.aggregate({
        where: { status: "confirmed" },
        _sum: { amount: true },
        _count: true,
      }),
      db.liquidityWithdrawal.aggregate({
        where: { status: "confirmed" },
        _sum: { amount: true, feeAmount: true },
        _count: true,
      }),
      db.liquidityPosition.count(),
      db.liquidityPosition.count({
        where: { status: "active" },
      }),
      db.liquidityRewardClaim.aggregate({
        where: { status: "confirmed" },
        _sum: { feeX: true, feeY: true, platformFeeX: true, platformFeeY: true },
        _count: true,
      }),
      db.auditLog.count({
        where: {
          OR: [
            { action: "liquidity_add_refund_failed" },
            { action: "liquidity_remove_withdrawal_failed" },
            { action: "liquidity_claim_withdrawal_failed" },
          ],
        },
      }),
    ]);

    return success(c, "Liquidity summary retrieved.", {
      deposits: {
        count: totalDeposits._count,
        totalAmount: totalDeposits._sum.amount || 0,
      },
      withdrawals: {
        count: totalWithdrawals._count,
        totalAmount: totalWithdrawals._sum.amount || 0,
        totalFeesCollected: totalWithdrawals._sum.feeAmount || 0,
      },
      positions: {
        total: totalPositions,
        active: activePositions,
        closed: totalPositions - activePositions,
      },
      rewards: {
        claimsCount: totalRewardClaims._count,
        totalFeeXClaimed: totalRewardClaims._sum.feeX || 0,
        totalFeeYClaimed: totalRewardClaims._sum.feeY || 0,
        platformFeesXCollected: totalRewardClaims._sum.platformFeeX || 0,
        platformFeesYCollected: totalRewardClaims._sum.platformFeeY || 0,
      },
      alerts: {
        failedTransfers,
      },
    });
  } catch (err) {
    return error(c, "Failed to retrieve liquidity summary.", 500, { error: String(err) });
  }
});

// =============================================================================
// Failed Transfers
// =============================================================================

// GET /liquidity/failed-transfers
liquidityRoutes.get("/failed-transfers", async (c) => {
  try {
    const failedAuditLogs = await db.auditLog.findMany({
      where: {
        OR: [
          { action: "liquidity_add_refund_failed" },
          { action: "liquidity_remove_withdrawal_failed" },
          { action: "liquidity_claim_withdrawal_failed" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const failedTransfers = failedAuditLogs.map((log) => ({
      id: log.id,
      agentId: log.agentId,
      action: log.action,
      asset: log.asset,
      amount: log.amount,
      toAddress: log.to,
      status: log.status,
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    }));

    return success(c, "Failed liquidity transfers retrieved.", {
      count: failedTransfers.length,
      transfers: failedTransfers,
    });
  } catch (err) {
    return error(c, "Failed to retrieve failed transfers.", 500, { error: String(err) });
  }
});

// =============================================================================
// Deposits
// =============================================================================

// GET /liquidity/deposits
liquidityRoutes.get("/deposits", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status");
    const poolAddress = c.req.query("pool");

    const deposits = await db.liquidityDeposit.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(poolAddress ? { poolAddress } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(deposits.map((d) => d.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const totalDeposits = await db.liquidityDeposit.aggregate({
      where: { status: "confirmed" },
      _sum: { amount: true },
      _count: true,
    });

    return success(c, "Liquidity deposits retrieved.", {
      count: deposits.length,
      totalCount: totalDeposits._count,
      deposits: deposits.map((d) => {
        const agent = agentMap.get(d.agentId);
        return {
          id: d.id,
          agentId: d.agentId,
          agentEmail: agent?.email,
          agentWallet: agent?.solanaAddress,
          poolAddress: d.poolAddress,
          tokenMint: d.tokenMint,
          tokenSymbol: d.tokenSymbol,
          amount: d.amount,
          amountRaw: d.amountRaw,
          solanaSignature: d.solanaSignature,
          status: d.status,
          createdAt: d.createdAt.toISOString(),
          confirmedAt: d.confirmedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve deposits.", 500, { error: String(err) });
  }
});

// =============================================================================
// Withdrawals
// =============================================================================

// GET /liquidity/withdrawals
liquidityRoutes.get("/withdrawals", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status");
    const poolAddress = c.req.query("pool");

    const withdrawals = await db.liquidityWithdrawal.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(poolAddress ? { poolAddress } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(withdrawals.map((w) => w.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const totalWithdrawals = await db.liquidityWithdrawal.aggregate({
      where: { status: "confirmed" },
      _sum: { amount: true, feeAmount: true },
      _count: true,
    });

    return success(c, "Liquidity withdrawals retrieved.", {
      count: withdrawals.length,
      totalCount: totalWithdrawals._count,
      totalAmount: totalWithdrawals._sum.amount || 0,
      totalFeesCollected: totalWithdrawals._sum.feeAmount || 0,
      withdrawals: withdrawals.map((w) => {
        const agent = agentMap.get(w.agentId);
        return {
          id: w.id,
          agentId: w.agentId,
          agentEmail: agent?.email,
          agentWallet: agent?.solanaAddress,
          poolAddress: w.poolAddress,
          positionId: w.positionId,
          tokenMint: w.tokenMint,
          tokenSymbol: w.tokenSymbol,
          amount: w.amount,
          amountRaw: w.amountRaw,
          feeBps: w.feeBps,
          feeAmount: w.feeAmount,
          solanaSignature: w.solanaSignature,
          status: w.status,
          createdAt: w.createdAt.toISOString(),
          processedAt: w.processedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve withdrawals.", 500, { error: String(err) });
  }
});

// =============================================================================
// Positions
// =============================================================================

// GET /liquidity/positions
liquidityRoutes.get("/positions", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status"); // active, closed
    const poolAddress = c.req.query("pool");

    const positions = await db.liquidityPosition.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(poolAddress ? { poolAddress } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(positions.map((p) => p.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const summary = await db.liquidityPosition.aggregate({
      _count: true,
    });

    return success(c, "Liquidity positions retrieved.", {
      count: positions.length,
      totalCount: summary._count,
      positions: positions.map((p) => {
        const agent = agentMap.get(p.agentId);
        return {
          id: p.id,
          agentId: p.agentId,
          agentEmail: agent?.email,
          poolAddress: p.poolAddress,
          poolName: p.poolName,
          positionPubkey: p.positionPubkey,
          strategy: p.strategy,
          minBinId: p.minBinId,
          maxBinId: p.maxBinId,
          amountX: p.amountX,
          amountY: p.amountY,
          mintX: p.mintX,
          mintY: p.mintY,
          symbolX: p.symbolX,
          symbolY: p.symbolY,
          entryFeeBps: p.entryFeeBps,
          exitFeeBps: p.exitFeeBps,
          status: p.status,
          createdAt: p.createdAt.toISOString(),
          closedAt: p.closedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve positions.", 500, { error: String(err) });
  }
});

// =============================================================================
// Rewards
// =============================================================================

// GET /liquidity/rewards
liquidityRoutes.get("/rewards", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status");

    const claims = await db.liquidityRewardClaim.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(claims.map((c) => c.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const summary = await db.liquidityRewardClaim.aggregate({
      where: { status: "confirmed" },
      _sum: { feeX: true, feeY: true, platformFeeX: true, platformFeeY: true },
      _count: true,
    });

    return success(c, "Reward claims retrieved.", {
      count: claims.length,
      totalCount: summary._count,
      totals: {
        feeX: summary._sum.feeX || 0,
        feeY: summary._sum.feeY || 0,
        platformFeeX: summary._sum.platformFeeX || 0,
        platformFeeY: summary._sum.platformFeeY || 0,
      },
      claims: claims.map((cl) => {
        const agent = agentMap.get(cl.agentId);
        return {
          id: cl.id,
          agentId: cl.agentId,
          agentEmail: agent?.email,
          positionId: cl.positionId,
          poolAddress: cl.poolAddress,
          feeX: cl.feeX,
          feeY: cl.feeY,
          platformFeeBps: cl.platformFeeBps,
          platformFeeX: cl.platformFeeX,
          platformFeeY: cl.platformFeeY,
          solanaSignatureX: cl.solanaSignatureX,
          solanaSignatureY: cl.solanaSignatureY,
          status: cl.status,
          createdAt: cl.createdAt.toISOString(),
          processedAt: cl.processedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve reward claims.", 500, { error: String(err) });
  }
});

// =============================================================================
// Admin Wallet (Meteora)
// =============================================================================

// GET /liquidity/wallet
liquidityRoutes.get("/wallet", async (c) => {
  try {
    if (!config.KNOT_METEORA_ADMIN_WALLET_ADDRESS) {
      return error(c, "Meteora admin wallet not configured", 503);
    }

    const adminPubkey = new PublicKey(config.KNOT_METEORA_ADMIN_WALLET_ADDRESS);

    // Get SOL balance
    const solBalance = await connection.getBalance(adminPubkey);
    const solBalanceSOL = solBalance / 1e9;

    // Get common token balances
    const tokenBalances: { mint: string; symbol: string; balance: number }[] = [];

    // Common tokens to check (USDC, USDT, SOL wrapped)
    const tokensToCheck = [
      { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
      { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", decimals: 6 },
    ];

    for (const token of tokensToCheck) {
      try {
        const tokenAccount = await getAssociatedTokenAddress(
          new PublicKey(token.mint),
          adminPubkey,
          false,
          TOKEN_PROGRAM_ID
        );
        const accountInfo = await getAccount(connection, tokenAccount, undefined, TOKEN_PROGRAM_ID);
        tokenBalances.push({
          mint: token.mint,
          symbol: token.symbol,
          balance: Number(accountInfo.amount) / Math.pow(10, token.decimals),
        });
      } catch {
        // Token account doesn't exist
        tokenBalances.push({
          mint: token.mint,
          symbol: token.symbol,
          balance: 0,
        });
      }
    }

    // Get position summary
    const [activePositions, totalDeposits, totalWithdrawals] = await Promise.all([
      db.liquidityPosition.count({ where: { status: "active" } }),
      db.liquidityDeposit.aggregate({
        where: { status: "confirmed" },
        _count: true,
      }),
      db.liquidityWithdrawal.aggregate({
        where: { status: "confirmed" },
        _sum: { feeAmount: true },
        _count: true,
      }),
    ]);

    return success(c, "Meteora admin wallet status retrieved.", {
      wallet: {
        address: config.KNOT_METEORA_ADMIN_WALLET_ADDRESS,
        solBalance: solBalanceSOL,
        tokenBalances,
      },
      activity: {
        activePositions,
        totalDeposits: totalDeposits._count,
        totalWithdrawals: totalWithdrawals._count,
        totalFeesCollected: totalWithdrawals._sum.feeAmount || 0,
      },
    });
  } catch (err) {
    return error(c, "Failed to retrieve wallet status.", 500, { error: String(err) });
  }
});

export { liquidityRoutes };
