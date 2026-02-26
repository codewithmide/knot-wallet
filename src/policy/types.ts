export interface AgentPolicy {
  maxSingleTransferSol: number;    // Max SOL per transaction
  dailyLimitSol: number;           // Rolling 24h SOL limit
  allowedRecipients: string[];     // Optional whitelist (empty = allow all)
  allowTrading: boolean;           // Can the agent swap tokens?
  allowLiquidity: boolean;         // Can the agent provide/remove liquidity?
  allowedPools: string[];          // Optional pool whitelist (empty = allow all)
  maxLiquidityPerPosition: number; // Max USD value per LP position
  allowPredictionMarkets: boolean; // Can the agent trade on Kalshi?
  maxPredictionOrderSize: number;  // Max contracts per prediction order
  sessionExpirationHours: number;  // How long session tokens last (in hours)
}

export const DEFAULT_POLICY: AgentPolicy = {
  maxSingleTransferSol: 1,
  dailyLimitSol: 5,
  allowedRecipients: [],           // empty = no whitelist, all allowed
  allowTrading: true,
  allowLiquidity: true,            // LP operations enabled by default
  allowedPools: [],                // empty = no whitelist, all pools allowed
  maxLiquidityPerPosition: 1000,   // Max $1000 per position
  allowPredictionMarkets: true,    // Prediction markets enabled by default
  maxPredictionOrderSize: 100,     // Max 100 contracts per order
  sessionExpirationHours: 168,     // 7 days (168 hours)
};
