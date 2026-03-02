import { PublicKey } from "@solana/web3.js";
import { connection } from "../../turnkey/signer.js";
import { DLMM } from "./meteora.js";
import { METEORA_API } from "./types.js";
import type { PoolInfo } from "./types.js";
import { logger } from "../../utils/logger.js";
import { LiquidityError } from "../../utils/errors.js";

/**
 * List available DLMM pools from Meteora API.
 */
export async function listPools(options?: {
  tokenX?: string;
  tokenY?: string;
  limit?: number;
}): Promise<PoolInfo[]> {
  const { tokenX, tokenY, limit = 50 } = options || {};

  logger.info("Fetching DLMM pools from Meteora", { tokenX, tokenY, limit });

  // Use paginated endpoint to avoid OOM from fetching all 70k+ pools
  const searchTerm = [tokenX, tokenY].filter(Boolean).join("-") || undefined;
  const params = new URLSearchParams({
    page: "0",
    limit: String(limit),
  });
  if (searchTerm) params.set("search_term", searchTerm);

  const response = await fetch(`${METEORA_API}/pair/all_by_groups?${params}`);
  if (!response.ok) {
    throw new LiquidityError(`Meteora API error: ${response.status}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: { groups: { name: string; pairs: any[] }[]; total: number } = await response.json();

  // Flatten groups into a single pool list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pools: any[] = data.groups.flatMap((g) => g.pairs);

  // Sort by liquidity and limit
  pools = pools
    .sort((a, b) => parseFloat(b.liquidity || "0") - parseFloat(a.liquidity || "0"))
    .slice(0, limit);

  return pools.map((p) => ({
    address: p.address,
    name: p.name,
    mintX: p.mint_x,
    mintY: p.mint_y,
    symbolX: p.name.split("-")[0] || "Unknown",
    symbolY: p.name.split("-")[1] || "Unknown",
    binStep: p.bin_step,
    baseFeePercentage: p.base_fee_percentage,
    liquidity: p.liquidity || "0",
    feeApr: p.fee_apr || "0",
    apr: p.apr || "0",
    tradeVolume24h: p.trade_volume_24h || "0",
  }));
}

/**
 * Get pool details including on-chain active bin info.
 */
export async function getPoolInfo(poolAddress: string) {
  const response = await fetch(`${METEORA_API}/pair/${poolAddress}`);
  if (!response.ok) {
    throw new LiquidityError(`Pool not found: ${poolAddress}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool: any = await response.json();

  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  const activeBin = await dlmmPool.getActiveBin();

  return {
    address: pool.address,
    name: pool.name,
    mintX: pool.mint_x,
    mintY: pool.mint_y,
    symbolX: pool.name.split("-")[0] || "Unknown",
    symbolY: pool.name.split("-")[1] || "Unknown",
    binStep: pool.bin_step,
    baseFeePercentage: pool.base_fee_percentage,
    liquidity: pool.liquidity || "0",
    feeApr: pool.fee_apr || "0",
    apr: pool.apr || "0",
    tradeVolume24h: pool.trade_volume_24h || "0",
    activeBinId: activeBin.binId,
    activePrice: activeBin.price,
  };
}
