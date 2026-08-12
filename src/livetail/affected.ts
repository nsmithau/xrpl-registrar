import { asRecord, asString } from "../discovery/fields.js";

/**
 * The in-scope accounts a transaction touches, from its JSON and metadata:
 * the `Account`/`Destination`/`Holder` fields plus the owners of any affected
 * ledger objects. Intersected with `scope` so out-of-scope parties are ignored.
 */
export function affectedAccounts(
  txJson: unknown,
  meta: unknown,
  scope: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();

  const tx = asRecord(txJson);
  if (tx) {
    for (const field of ["Account", "Destination", "Holder"]) {
      const value = asString(tx[field]);
      if (value && scope.has(value)) found.add(value);
    }
  }

  const metaRecord = asRecord(meta);
  const nodes = Array.isArray(metaRecord?.AffectedNodes) ? metaRecord.AffectedNodes : [];
  for (const raw of nodes) {
    const wrapper = asRecord(raw);
    if (!wrapper) continue;
    const node =
      asRecord(wrapper.CreatedNode) ??
      asRecord(wrapper.ModifiedNode) ??
      asRecord(wrapper.DeletedNode);
    const fields = node ? (asRecord(node.FinalFields) ?? asRecord(node.NewFields)) : undefined;
    const account = fields ? asString(fields.Account) : undefined;
    if (account && scope.has(account)) found.add(account);
  }

  return [...found];
}
