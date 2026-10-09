import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import { isWellFormedText } from './well-formed-text';

/** The decisions an admin takes on a seller's access (identity design 3.3; data design 3.11). */
export const ACCESS_DECISIONS = ['approved', 'rejected', 'suspended', 'reinstated'] as const;
export type AccessDecisionKind = (typeof ACCESS_DECISIONS)[number];

/** The decisions that need a reason (decision 9; AC 6, AC 14). */
const WITH_REASON: ReadonlySet<AccessDecisionKind> = new Set(['rejected', 'suspended']);

/**
 * The longest reason, in code points after trimming. A domain limit, not a Market policy: the
 * reason is one paragraph for the seller (`ux.md` D4 "maximum length from the API"), and the
 * ciphertext it becomes must stay a small row.
 */
export const MAX_ACCESS_REASON_LENGTH = 2000;

/**
 * Why a reason was refused (identity design 8.6 row 1): empty is `seller-access.reason-required`;
 * too long or with a forbidden character is `validation.failed` with its rule.
 */
export type AccessReasonInvalid =
  | { readonly code: 'seller-access.reason-required' }
  | { readonly code: 'validation.failed'; readonly rule: 'length' | 'characters' };

/**
 * C0 and C1 controls, every format character (`\p{Cf}`: the bidi marks, embeddings, overrides and
 * isolates, zero-width spaces, the BOM, the deprecated format controls U+206A to U+206F) and the
 * line and paragraph separators U+2028 and U+2029 (HF13; Hassan L3 on PR #204): the reason
 * reaches a plain-text mail and the seller's status page, so nothing in it may reorder or hide
 * the text around it. The zero-width joiner stays, so emoji sequences still work; variation
 * selectors are not format characters (`Mn`) and stay too. Tested after the tab and the line
 * feed, the two controls a reason keeps, are taken out.
 */
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]|(?!\u200d)\p{Cf}/u;
const KEPT_CONTROLS = /[\t\n]/g;

/**
 * The reason of a rejection or a suspension (identity design 3.3, decision 9; HF13): written by
 * the admin for the seller, shown to the Seller Owner only, in the result mail and on the status
 * page. Line breaks are kept (CRLF and CR become LF), the whole is trimmed; 1 to
 * {@link MAX_ACCESS_REASON_LENGTH} code points; no control or bidi formatting character, no lone
 * surrogate. URLs are not refused: a reason may name a page of the seller's own business, and the
 * mail is plain text, so nothing in it is a link that code built (HF13; 9).
 *
 * Personal data: it is stored only encrypted, under the seller's key (data design 3.11), and never
 * put in an event, a log or an audit row (10.1).
 */
export function parseAccessReason(raw: unknown): Result<string, AccessReasonInvalid> {
  if (typeof raw !== 'string') return err({ code: 'seller-access.reason-required' });
  const reason = raw.replace(/\r\n?/g, '\n').trim();
  if (reason === '') return err({ code: 'seller-access.reason-required' });
  if ([...reason].length > MAX_ACCESS_REASON_LENGTH) {
    return err({ code: 'validation.failed', rule: 'length' });
  }
  if (!isWellFormedText(reason) || FORBIDDEN.test(reason.replace(KEPT_CONTROLS, ''))) {
    return err({ code: 'validation.failed', rule: 'characters' });
  }
  return ok(reason);
}

/** The state of an {@link AccessDecision} (identity design 2.1; data design 3.11). */
export interface AccessDecisionState {
  readonly id: Id<'AccessDecision'>;
  readonly marketId: MarketId;
  readonly sellerId: Id<'Seller'>;
  readonly decision: AccessDecisionKind;
  /** The reason in clear, in memory only: set if and only if rejected or suspended. */
  readonly reason: string | null;
  /** An id that means nothing to identity (`sellers`' submission, ADR-0022 decision 4). */
  readonly basisId: Id | null;
  /** Null for the system actor (data design C4: a plain id, no foreign key). */
  readonly decidedByAccountId: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant;
}

/** A decision that breaks an invariant of 3.3 or 3.11: a bug of the caller. */
export class AccessDecisionInvariantError extends Error {
  override readonly name = 'AccessDecisionInvariantError';
  constructor(readonly invariant: 'decision' | 'reason') {
    super(`AccessDecision invariant broken: ${invariant}`);
  }
}

/**
 * One decision on a seller's access (identity design 2.1 `AccessDecision`, 3.3; data design
 * 3.11): append-only, never changed once written. Built only by the transitions of
 * `SellerAccess` (approve, reject, suspend, reinstate), which check the state and parse the
 * reason, so a rejection or a suspension without a reason cannot be built (decision 9). The
 * tamper-evident trace is the audit row, which names the decision's id (10.1).
 */
export class AccessDecision {
  readonly #state: AccessDecisionState;

  private constructor(state: AccessDecisionState) {
    if (!(ACCESS_DECISIONS as readonly string[]).includes(state.decision)) {
      throw new AccessDecisionInvariantError('decision');
    }
    if (WITH_REASON.has(state.decision)) {
      const parsed = parseAccessReason(state.reason);
      if (!parsed.ok || parsed.value !== state.reason) {
        throw new AccessDecisionInvariantError('reason');
      }
    } else if (state.reason !== null) {
      throw new AccessDecisionInvariantError('reason');
    }
    this.#state = Object.freeze({ ...state });
  }

  /** Whether a decision of this kind carries a reason (decision 9). */
  static needsReason(decision: AccessDecisionKind): boolean {
    return WITH_REASON.has(decision);
  }

  /** A new decision; for `SellerAccess` only, after its own checks. */
  static decide(state: AccessDecisionState): AccessDecision {
    return new AccessDecision(state);
  }

  /** A decision as it was written (tests and a full read). Checks the invariants again. */
  static restore(state: AccessDecisionState): AccessDecision {
    return new AccessDecision(state);
  }

  get state(): AccessDecisionState {
    return this.#state;
  }
}
