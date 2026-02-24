export interface AgentPolicy {
  maxSingleTransferSol: number;    // Max SOL per transaction
  dailyLimitSol: number;           // Rolling 24h SOL limit
  allowedRecipients: string[];     // Optional whitelist (empty = allow all)
  allowTrading: boolean;           // Can the agent swap tokens?
  sessionExpirationHours: number;  // How long session tokens last (in hours)
}

export const DEFAULT_POLICY: AgentPolicy = {
  maxSingleTransferSol: 1,
  dailyLimitSol: 5,
  allowedRecipients: [],           // empty = no whitelist, all allowed
  allowTrading: true,
  sessionExpirationHours: 168,     // 7 days (168 hours)
};
