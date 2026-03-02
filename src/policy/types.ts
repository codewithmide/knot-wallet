export interface AgentPolicy {
  maxSingleTransactionInUsd: number; // Max USD value per transaction (applies to all: transfers, trades, LP, predictions)
  dailyLimitInUsd: number;           // Rolling 24h USD limit (all outbound operations)
  allowedRecipients: string[];       // Optional whitelist for transfer recipients (empty = allow all)
  allowTrading: boolean;             // Can the agent swap tokens?
  allowLiquidityProvision: boolean;  // Can the agent provide/remove liquidity?
  allowPredictionMarkets: boolean;   // Can the agent trade on Kalshi?
  sessionExpirationHours: number;    // How long session tokens last (in hours)
}

export const DEFAULT_POLICY: AgentPolicy = {
  maxSingleTransactionInUsd: 100,    // Max $100 per transaction
  dailyLimitInUsd: 500,              // Max $500 per day across all operations
  allowedRecipients: [],             // empty = no whitelist, all allowed
  allowTrading: true,
  allowLiquidityProvision: true,     // LP operations enabled by default
  allowPredictionMarkets: true,      // Prediction markets enabled by default
  sessionExpirationHours: 168,       // 7 days (168 hours)
};
