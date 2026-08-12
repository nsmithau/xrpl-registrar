import { asRecord } from "./fields.js";
import type { ClioReader } from "./types.js";

/**
 * `MPTokenIssuance` "holders must be authorised" flag, as it appears in the
 * ledger object's `Flags` returned by `ledger_entry`. 0x0004 — the same value
 * as the `tfMPTRequireAuth` creation flag. Verified against live testnet
 * issuances (a non-auth issuance reads 0x3A, an auth-required one 0x7E).
 */
export const LSF_MPT_REQUIRE_AUTH = 0x0004;

/**
 * Read an MPT issuance's on-ledger flags and report whether it requires
 * authorisation — the input that decides auth-scan vs traversal.
 */
export async function detectRequiresAuth(
  client: ClioReader,
  mptIssuanceId: string,
): Promise<boolean> {
  const res = await client.request<{ node?: unknown }>({
    command: "ledger_entry",
    mpt_issuance: mptIssuanceId,
    ledger_index: "validated",
  });
  const node = asRecord(res.result.node);
  const flags = typeof node?.Flags === "number" ? node.Flags : 0;
  return (flags & LSF_MPT_REQUIRE_AUTH) !== 0;
}
