import * as MeteoraModule from "@meteora-ag/dlmm";

// The default export requires special handling due to how the package is built
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DLMM: any = (MeteoraModule as any).default;

export const { StrategyType, autoFillYByStrategy } = MeteoraModule;

/**
 * Convert our string strategy name to the Meteora SDK StrategyType enum.
 */
export function getStrategyType(
  strategy: "spot" | "curve" | "bidAsk"
): typeof StrategyType[keyof typeof StrategyType] {
  switch (strategy) {
    case "spot":
      return StrategyType.Spot;
    case "curve":
      return StrategyType.Curve;
    case "bidAsk":
      return StrategyType.BidAsk;
    default:
      return StrategyType.Spot;
  }
}
