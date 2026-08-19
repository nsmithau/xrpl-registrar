/**
 * Tiny end-to-end demo.
 *
 * Registers an MPT issuance, discovers its holders from a live Clio, backfills
 * their transactions into in-process Postgres, and queries the archive back —
 * exercising the governed Clio client, provenance stamping, and idempotent
 * storage together in one pass.
 *
 * Run it against any full-history testnet Clio (endpoint via env, so no host is
 * baked into the source):
 *
 *   CLIO_ENDPOINT=wss://<testnet-clio-endpoint> pnpm demo
 *
 * Override the issuance if you like:
 *
 *   MPT_ISSUANCE_ID=<hex> CLIO_ENDPOINT=wss://<testnet-clio-endpoint> pnpm demo
 *
 * This is a demonstration, not the real ingestion pipeline: discovery is a
 * single mpt_holders call, backfill fetches one small page per account, and no
 * balance deltas are derived.
 */
import { decode, encodeAccountID, hashes } from "xrpl";

import { openArchiveDatabase } from "../src/db/index.js";
import { IssuanceRepository } from "../src/db/repositories/issuances.js";
import { TransactionRepository } from "../src/db/repositories/transactions.js";
import { createClioClient, loadConfig } from "../src/index.js";
import { nullLogger } from "../src/logging/logger.js";

const DEFAULT_MPT_ID = "000000011515151515151515151515151515151515151515";
const PAGE_LIMIT = 20;

interface AccountTxResult {
  transactions?: Array<{ tx_blob: string; meta_blob: string; ledger_index: number }>;
  marker?: unknown;
  ledger_index_min: number;
  ledger_index_max: number;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** MPTokenIssuanceID = 4-byte sequence + 20-byte issuer AccountID. */
function decodeIssuer(mptId: string): string {
  return encodeAccountID(Buffer.from(hexToBytes(mptId.slice(8))));
}

async function main(): Promise<void> {
  const mptId = (process.env.MPT_ISSUANCE_ID ?? DEFAULT_MPT_ID).toUpperCase();
  const issuer = decodeIssuer(mptId);

  console.log(`MPT issuance : ${mptId}`);
  console.log(`Issuer       : ${issuer} (decoded locally, no network)\n`);

  const { client, governor } = createClioClient(loadConfig(), nullLogger);
  const db = await openArchiveDatabase(); // in-memory for the demo
  const issuances = new IssuanceRepository(db);
  const transactions = new TransactionRepository(db);

  await client.connect();
  try {
    console.log(`Connected to ${client.endpoint}`);

    // 1. Register the issuance.
    const issuance = await issuances.create({ kind: "mpt", mptIssuanceId: mptId });
    console.log(`Registered issuance #${issuance.id}\n`);

    // 2. Discover holders (Clio-only mpt_holders) and include the issuer.
    const holdersRes = await client.request<{ mptokens: Array<{ account: string }> }>({
      command: "mpt_holders",
      mpt_issuance_id: mptId,
    });
    const holders = holdersRes.result.mptokens.map((m) => m.account);
    const scope = [...new Set([issuer, ...holders])];
    console.log(`Discovered ${holders.length} holder(s); scope = ${scope.length} account(s)`);
    console.log(
      `  provenance: ${holdersRes.provenance.sourceEndpoint} @ ${holdersRes.provenance.fetchedAt}\n`,
    );

    for (const address of scope) {
      await db.query("INSERT INTO accounts (address) VALUES ($1) ON CONFLICT DO NOTHING", [
        address,
      ]);
      await db.query(
        `INSERT INTO account_issuance (address, issuance_id, discovered_via)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [address, issuance.id, address === issuer ? "issuer" : "mpt_holders"],
      );
    }

    // 3. Backfill: one small page of account_tx per in-scope account, ingested
    //    as raw blobs with provenance. Idempotent, so a tx shared by two
    //    in-scope accounts yields one transactions row and two links.
    for (const account of scope) {
      const res = await client.request<AccountTxResult>({
        command: "account_tx",
        account,
        forward: true,
        binary: true,
        limit: PAGE_LIMIT,
      });
      const entries = res.result.transactions ?? [];

      for (const entry of entries) {
        const decoded = decode(entry.tx_blob) as { TransactionType?: string };
        await transactions.ingest({
          hash: hashes.hashSignedTx(entry.tx_blob),
          ledgerIndex: entry.ledger_index,
          txType: decoded.TransactionType ?? "unknown",
          mptIssuanceId: null, // synthetic field is only present in JSON responses
          txBlob: hexToBytes(entry.tx_blob),
          metaBlob: hexToBytes(entry.meta_blob),
          provenance: res.provenance,
          accounts: [account],
        });
      }

      // Only claim coverage if we exhausted the account's history (no marker).
      const complete = res.result.marker === undefined;
      if (complete) {
        await db.query(
          `INSERT INTO coverage (address, from_ledger, to_ledger, reason)
           VALUES ($1, $2, $3, $4)`,
          [
            account,
            res.result.ledger_index_min,
            res.result.ledger_index_max,
            "account_tx exhausted",
          ],
        );
      }
      console.log(
        `  ${account}: ${entries.length} tx${complete ? "" : " (more pages remain — no coverage claimed)"}`,
      );
    }

    // 4. Query the archive back.
    console.log("\n--- archive contents ---");
    console.log(`transactions (deduped) : ${await transactions.countTransactions()}`);

    const links = await db.query<{ n: number | string }>(
      "SELECT count(*)::bigint AS n FROM account_transactions",
    );
    console.log(`account_transactions   : ${Number(links.rows[0]!.n)}`);

    const byType = await db.query<{ tx_type: string; n: number | string }>(
      "SELECT tx_type, count(*)::bigint AS n FROM transactions GROUP BY tx_type ORDER BY n DESC, tx_type",
    );
    console.log(
      `by type                : ${byType.rows.map((r) => `${r.tx_type}=${r.n}`).join(", ")}`,
    );

    const coverage = await db.query<{ address: string; from_ledger: string; to_ledger: string }>(
      "SELECT address, from_ledger, to_ledger FROM coverage ORDER BY address",
    );
    for (const c of coverage.rows) {
      console.log(`coverage ${c.address}: ledgers ${c.from_ledger}–${c.to_ledger}`);
    }

    const sample = await db.query<{ hash: string; source_endpoint: string; fetched_at: unknown }>(
      "SELECT hash, source_endpoint, fetched_at FROM transactions ORDER BY ledger_index LIMIT 1",
    );
    if (sample.rows[0]) {
      const s = sample.rows[0];
      console.log(`sample provenance      : ${s.hash.slice(0, 16)}… via ${s.source_endpoint}`);
    }

    console.log(`\ngovernor stats         : ${JSON.stringify(governor.stats())}`);
  } finally {
    await client.disconnect();
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
