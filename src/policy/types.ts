export interface AgentPolicy {
  maxSingleTransferSol: number;    // Max SOL per transaction
  maxSingleTransferUsdc: number;   // Max USDC per transaction
  dailyLimitSol: number;           // Rolling 24h SOL limit
  dailyLimitUsdc: number;          // Rolling 24h USDC limit
  allowedRecipients: string[];     // Optional whitelist (empty = allow all)
  allowedPrograms: string[];       // Optional program whitelist for sign-tx
  allowTrading: boolean;           // Can the agent swap tokens?
  allowExternalSigning: boolean;   // Can agent sign txs from external sources?
  sessionExpirationHours: number;  // How long session tokens last (in hours)
}

export const DEFAULT_POLICY: AgentPolicy = {
  maxSingleTransferSol: 1,
  maxSingleTransferUsdc: 100,
  dailyLimitSol: 5,
  dailyLimitUsdc: 500,
  allowedRecipients: [],           // empty = no whitelist, all allowed
  allowedPrograms: [],
  allowTrading: true,
  allowExternalSigning: false,     // Off by default — must be explicitly enabled
  sessionExpirationHours: 168,     // 7 days (168 hours)
};
