import type { DiscoveryStrategyName, DiscoveryTarget } from "./types.js";

/**
 * Select the discovery strategy for a target.
 *
 * An explicit `strategy` override wins. Otherwise: IOUs use the trustline scan;
 * auth-required MPTs use the authorisation scan (an optimisation valid only
 * because authorisation routes every holder through the issuer); every other
 * MPT falls back to traversal, which is always complete.
 */
export function resolveStrategy(target: DiscoveryTarget): DiscoveryStrategyName {
  const override = target.strategy;
  if (override !== undefined && override !== "auto") return override;
  if (target.kind === "iou") return "trustline";
  return target.requiresAuth === true ? "authorization" : "traversal";
}
