# Postman collection

`xrpl-registrar.postman_collection.json` — the **Admin API** and the tool-specific
**`archive_*` reporting extensions**, plus a couple of Clio-compatible read
examples for convenience.

## Import

Postman → **Import** → select `xrpl-registrar.postman_collection.json`. The
collection ships its own variables (no separate environment needed), but you can
promote them to an environment if you prefer.

## Set the variables

| Variable | What it is | Default |
|----------|------------|---------|
| `readUrl` | Public read API base URL | `http://127.0.0.1:51234` |
| `adminUrl` | Admin API base URL (separate port) | `http://127.0.0.1:51235` |
| `adminToken` | Your `ADMIN_TOKEN` — **required for the Admin folder** | *(empty)* |
| `mptIssuanceId` | 48-hex MPTokenIssuanceID to query | a testnet example |
| `account` | An issuer/holder address (`r…`) | *(empty)* |
| `currency` / `issuer` | IOU identity (alternative to `mptIssuanceId`) | `USD` / *(empty)* |
| `issuanceId` | Numeric issuance id | `1` (auto-set by *Register*) |

At minimum set `adminToken`, and set `mptIssuanceId` + `account` (or
`currency` + `issuer`) to real values.

## Layout

- **Admin API (authenticated)** — register / list / inspect / pause / resume
  issuances. Bearer auth (`{{adminToken}}`) is applied at the folder level.
  *Register MPT issuance* saves the returned id into `{{issuanceId}}`.
- **Reporting extensions (`archive_*`)** — `archive_balance_at` (point-in-time
  balance) and `archive_transactions` (itemised per-transaction balance changes),
  the latter filterable by account, ledger range, or date range (`"validated"` =
  latest). Served from the read API over HTTP JSON-RPC; `api_version: 2` is
  included on every request.
- **Archive reads (Clio-compatible)** — `mpt_holders` and `account_tx`. These
  mirror Clio exactly and are **not** specific to this tool (any Clio/xrpl.js
  client works against the read port); included to show the fail-closed scope
  behaviour (`notInArchive`).

## Typical flow

1. **Admin → Register issuance** — kicks off discovery + backfill in the
   background; note the `issuanceId` it saves.
2. **Admin → Get issuance status** — poll until `backfill.completed` catches up
   and `coverage` is populated.
3. **Reporting extensions** — query balances and deltas by ledger or date.

## Notes

- The read API is a Clio-compatible JSON-RPC endpoint, so the reporting requests
  work with `curl`/xrpl.js too — the collection just packages them.
- Never expose the admin port publicly; it surfaces account addresses and
  archive scope.
- Time-based reporting (`date` / `from_time` / `to_time`) needs ledger close
  times to have been captured (they are, as part of ingest), else it returns an
  explicit error rather than guessing.
