/**
 * Driver-level behaviour of the networked Postgres engine: the places where
 * `pg` and PGlite could plausibly disagree, and where a silent difference
 * would corrupt data rather than raise an error.
 *
 * Skipped unless TEST_DATABASE_URL is set — `pnpm test:pg`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../src/db/database.js";
import { PostgresDatabase } from "../../src/db/postgres.js";
import { insertTransactionRowsMany } from "../../src/db/repositories/transactions.js";
import { openTestDatabase, usingPostgres } from "../dbHelpers.js";

const entry = (hash: string, accounts: string[] = ["rA"]) => ({
  hash,
  ledgerIndex: 100,
  txType: "Payment",
  txBlob: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  metaBlob: new Uint8Array([0x01, 0x02, 0x03]),
  provenance: { sourceEndpoint: "wss://clio.test", fetchedAt: new Date().toISOString() },
  accounts,
});

describe.skipIf(!usingPostgres)("PostgresDatabase", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openTestDatabase();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("type mapping", () => {
    // pg returns int8 as a string by default; PGlite returns a number. The
    // repositories coerce either way, but the engines must agree or the two
    // test runs are not really running the same assertions.
    it("returns BIGINT as a number, matching PGlite", async () => {
      await db.transaction((t) => insertTransactionRowsMany(t, [entry("AA")]));
      const { rows } = await db.query<{ ledger_index: unknown }>(
        "SELECT ledger_index FROM transactions WHERE hash = $1",
        ["AA"],
      );
      expect(typeof rows[0]!.ledger_index).toBe("number");
      expect(rows[0]!.ledger_index).toBe(100);
    });

    // Silently truncating a ledger index to a wrong-but-plausible number is
    // far worse than failing, so the parser refuses rather than rounds.
    it("refuses a BIGINT too large to survive as a JS number", async () => {
      await expect(db.query("SELECT 9007199254740993::bigint AS n")).rejects.toThrow(
        /exceeds the safe integer range/,
      );
    });

    it("leaves types it does not override alone", async () => {
      const { rows } = await db.query<{ b: unknown; i: unknown; t: unknown }>(
        "SELECT true AS b, 42::int AS i, 'x'::text AS t",
      );
      expect(rows[0]).toEqual({ b: true, i: 42, t: "x" });
    });

    it("round-trips BYTEA blobs byte for byte", async () => {
      await db.transaction((t) => insertTransactionRowsMany(t, [entry("BB")]));
      const { rows } = await db.query<{ tx_blob: Uint8Array }>(
        "SELECT tx_blob FROM transactions WHERE hash = $1",
        ["BB"],
      );
      // pg hands back a Buffer, PGlite a bare Uint8Array; Buffer is a
      // Uint8Array, which is all the decoding path relies on.
      expect(rows[0]!.tx_blob).toBeInstanceOf(Uint8Array);
      expect([...rows[0]!.tx_blob]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it("round-trips a JSONB backfill marker as an object", async () => {
      await db.query("INSERT INTO accounts (address) VALUES ('rM')");
      await db.query("INSERT INTO issuances (kind, mpt_issuance_id) VALUES ('mpt', 'MPT1')");
      const { rows: iss } = await db.query<{ id: number }>("SELECT id FROM issuances");
      await db.query(
        "INSERT INTO backfill_job (address, issuance_id, last_marker) VALUES ('rM', $1, $2::jsonb)",
        [iss[0]!.id, JSON.stringify({ ledger: 7, seq: 3 })],
      );
      const { rows } = await db.query<{ last_marker: unknown }>(
        "SELECT last_marker FROM backfill_job WHERE address = 'rM'",
      );
      expect(rows[0]!.last_marker).toEqual({ ledger: 7, seq: 3 });
    });
  });

  describe("transactions", () => {
    it("reports affectedRows, which the issuance-delete report depends on", async () => {
      await db.query("INSERT INTO accounts (address) VALUES ('r1'), ('r2'), ('r3')");
      const deleted = await db.query("DELETE FROM accounts WHERE address <> 'r1'");
      expect(deleted.affectedRows).toBe(2);
    });

    it("rolls back every write when the body throws", async () => {
      await expect(
        db.transaction(async (t) => {
          await insertTransactionRowsMany(t, [entry("ROLLBACK")]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::bigint AS n FROM transactions WHERE hash = 'ROLLBACK'",
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    // Only deadlock/serialization failures are retryable. A bad statement must
    // surface immediately rather than be re-run until the retry budget runs out.
    it("propagates a non-retryable error instead of retrying it", async () => {
      let attempts = 0;
      await expect(
        db.transaction(async (t) => {
          attempts += 1;
          await t.query("SELECT * FROM no_such_table");
        }),
      ).rejects.toThrow(/no_such_table/);
      expect(attempts).toBe(1);
    });

    it("returns the connection to the pool after a failure", async () => {
      for (let i = 0; i < 12; i += 1) {
        await expect(db.transaction((t) => t.query("SELECT * FROM nope"))).rejects.toThrow();
      }
      // A leaked connection per failure would exhaust the pool (max 4) well
      // before here and this would hang rather than answer.
      const { rows } = await db.query<{ ok: number }>("SELECT 1 AS ok");
      expect(rows[0]!.ok).toBe(1);
    });
  });

  describe("schema isolation", () => {
    it("keeps each test database in its own schema", async () => {
      const other = await openTestDatabase();
      try {
        const name = async (d: Database): Promise<string> =>
          (await d.query<{ s: string }>("SELECT current_schema() AS s")).rows[0]!.s;
        expect(await name(db)).not.toBe(await name(other));

        // Writes must not be visible across them, despite one database.
        await db.query("INSERT INTO accounts (address) VALUES ('rIsolated')");
        const { rows } = await other.query<{ n: number }>(
          "SELECT count(*)::bigint AS n FROM accounts WHERE address = 'rIsolated'",
        );
        expect(Number(rows[0]!.n)).toBe(0);
      } finally {
        await other.close();
      }
    });

    // The schema goes into a connection string, where no bind parameter is
    // available, so it is validated rather than escaped.
    it("rejects a schema name that is not a plain identifier", () => {
      expect(() =>
        PostgresDatabase.open({
          connectionString: "postgres://localhost/x",
          schema: "public; DROP TABLE accounts",
        }),
      ).toThrow(/not a valid unquoted sql identifier/i);
    });
  });
});
