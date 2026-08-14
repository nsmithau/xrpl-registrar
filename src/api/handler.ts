import type { Database } from "../db/database.js";
import { nullLogger, type Logger } from "../logging/logger.js";

import { errorResult, invalidApiVersion, unsupported } from "./errors.js";
import { DisabledForwarder, type Forwarder } from "./forwarder.js";
import { handleAccountInfo, handleAccountLines } from "./methods/accountState.js";
import { handleAccountTx } from "./methods/accountTx.js";
import { handleMptHolders } from "./methods/mptHolders.js";
import { handleBalanceAt, handleDeltas } from "./methods/reporting.js";
import { handleTx } from "./methods/tx.js";
import { ScopeRepository } from "./scope.js";
import type { ApiRequest, ApiResponse, MethodResult } from "./types.js";
import { forwardedNotArchiveWarning, localWarnings } from "./warnings.js";

// Method classes (docs: decide a method's class before implementing it).
const NODE_STATE = new Set(["server_info", "ledger", "fee"]);
const SUBMISSION = new Set(["submit", "submit_multisigned"]);
const ARCHIVE_SCOPED = new Set(["account_tx", "tx", "account_info", "account_lines", "mpt_holders"]);
const ACCOUNT_SCOPED = new Set(["account_tx", "account_info", "account_lines"]);
// Reporting extensions — archive-only computations, never forwarded.
const REPORTING = new Set(["archive_balance_at", "archive_deltas"]);
const IMPLEMENTED_ARCHIVE = new Set([
  "account_tx",
  "tx",
  "account_info",
  "account_lines",
  "mpt_holders",
]);

export interface ArchiveApiOptions {
  readonly db: Database;
  /** Upstream proxy for node-state, submission, and (if enabled) out-of-scope
   * reads. Defaults to refusing. */
  readonly forwarder?: Forwarder;
  /** Forward out-of-scope account reads instead of failing closed. Default
   * false — the archive fails closed. */
  readonly forwardUnknownAccounts?: boolean;
  readonly logger?: Logger;
}

/**
 * The Clio-compatible read API, as a transport-decoupled request handler.
 * Enforces `api_version 2`, classifies the method, serves archive-scoped reads
 * from storage (fail-closed when out of scope), forwards node-state/submission,
 * and returns an explicit error for anything unsupported — never a plausible
 * empty answer.
 */
export class ArchiveApi {
  readonly #db: Database;
  readonly #scope: ScopeRepository;
  readonly #forwarder: Forwarder;
  readonly #forwardUnknown: boolean;
  readonly #logger: Logger;

  constructor(options: ArchiveApiOptions) {
    this.#db = options.db;
    this.#scope = new ScopeRepository(options.db);
    this.#forwarder = options.forwarder ?? new DisabledForwarder();
    this.#forwardUnknown = options.forwardUnknownAccounts ?? false;
    this.#logger = options.logger ?? nullLogger;
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    if (req.api_version !== 2) {
      return this.#local(invalidApiVersion(req.api_version));
    }

    const cmd = req.command;

    if (REPORTING.has(cmd)) {
      const mr =
        cmd === "archive_balance_at"
          ? await handleBalanceAt(this.#db, this.#scope, req)
          : await handleDeltas(this.#db, this.#scope, req);
      return this.#localFrom(mr);
    }

    if (NODE_STATE.has(cmd) || SUBMISSION.has(cmd)) {
      return this.#forward(req);
    }

    if (ARCHIVE_SCOPED.has(cmd)) {
      if (!IMPLEMENTED_ARCHIVE.has(cmd)) return this.#local(unsupported(cmd));

      // Out-of-scope account reads: fail closed by default, forward only if
      // explicitly enabled (and then clearly marked as not archive-sourced).
      if (this.#forwardUnknown && ACCOUNT_SCOPED.has(cmd)) {
        const account = typeof req.account === "string" ? req.account : undefined;
        if (account && !(await this.#scope.inScope(account))) {
          return this.#forward(req);
        }
      }

      const mr = await this.#dispatchArchive(cmd, req);
      return this.#localFrom(mr);
    }

    return this.#local(unsupported(cmd));
  }

  async #dispatchArchive(cmd: string, req: ApiRequest): Promise<MethodResult> {
    switch (cmd) {
      case "account_tx":
        return handleAccountTx(this.#db, this.#scope, req);
      case "tx":
        return handleTx(this.#db, this.#scope, req);
      case "account_info":
        return handleAccountInfo(this.#db, this.#scope, req);
      case "account_lines":
        return handleAccountLines(this.#db, this.#scope, req);
      case "mpt_holders":
        return handleMptHolders(this.#db, this.#scope, req);
      default:
        return { result: unsupported(cmd) };
    }
  }

  async #local(result: Record<string, unknown>): Promise<ApiResponse> {
    return { result, warnings: localWarnings(), forwarded: false };
  }

  async #localFrom(mr: MethodResult): Promise<ApiResponse> {
    return {
      result: mr.result,
      warnings: [...localWarnings(), ...(mr.extraWarnings ?? [])],
      forwarded: false,
    };
  }

  async #forward(req: ApiRequest): Promise<ApiResponse> {
    try {
      const forwarded = await this.#forwarder.forward(req);
      return {
        result: forwarded.result,
        warnings: [...forwarded.warnings, forwardedNotArchiveWarning()],
        forwarded: true,
      };
    } catch (err) {
      this.#logger.error("forwarding failed", { command: req.command, error: String(err) });
      return this.#local(
        errorResult("forwardingUnavailable", `Could not forward '${req.command}' upstream.`),
      );
    }
  }
}
