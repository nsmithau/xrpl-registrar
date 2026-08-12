import type { DiscoveredAccount, DiscoveryStrategyName } from "./types.js";

/** Narrow an unknown to a plain object, or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrow an unknown to a string, or undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Record an address, keeping the earliest (smallest) known ledger. */
export function recordEarliest(
  map: Map<string, number | null>,
  address: string,
  ledger: number | null,
): void {
  const prev = map.get(address);
  if (prev === undefined) {
    map.set(address, ledger);
    return;
  }
  if (prev === null) {
    if (ledger !== null) map.set(address, ledger);
    return;
  }
  if (ledger !== null && ledger < prev) map.set(address, ledger);
}

/** Materialise the accumulator into a stable, address-sorted result. */
export function toAccounts(
  map: Map<string, number | null>,
  via: DiscoveryStrategyName,
): DiscoveredAccount[] {
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([address, firstAcquisitionLedger]) => ({
      address,
      discoveredVia: via,
      firstAcquisitionLedger,
    }));
}
