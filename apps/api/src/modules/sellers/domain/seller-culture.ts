import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// A seller's membership of a culture (multi-culture package 2; ADR-0047 decision 3).
//
//   (none) --request--> requested --approve--> approved
//                           |  ^
//                        reject  \--request again--\
//                           v                       |
//                        rejected -----------------/
//
// A seller asks and a reviewer decides. An approved membership is final here. The culture itself is
// `catalog`'s; the id and the code are plain values. The certificate rule of a culture with a
// required certification type is the use case's check (it reads certification), not stored.

export const SELLER_CULTURE_STATUSES = ['requested', 'approved', 'rejected'] as const;
export type SellerCultureStatus = (typeof SELLER_CULTURE_STATUSES)[number];

/** The most cultures one request may name. */
export const CULTURES_PER_REQUEST_MAX = 20;
export const CULTURE_DECISION_REASON_MAX = 300;

export interface SellerCultureState {
  readonly sellerId: Id<'Seller'>;
  readonly cultureId: Id<'Culture'>;
  readonly cultureCode: string;
  readonly status: SellerCultureStatus;
  readonly reason: string | null;
  /** Null when the system made the request at signup (ADR-0048). */
  readonly requestedBy: Id<'Account'> | null;
  readonly requestedAt: Temporal.Instant;
  readonly decidedBy: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  /** Raised by every status change; the aggregate version of the membership's events. */
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
}

export interface CultureFieldProblem {
  readonly path: string;
  readonly code: string;
}

export interface MembershipRequest {
  readonly sellerId: Id<'Seller'>;
  readonly cultureId: Id<'Culture'>;
  readonly cultureCode: string;
  /** Null for the system at signup. */
  readonly by: Id<'Account'> | null;
  readonly at: Temporal.Instant;
}

export type RequestOutcome =
  | { readonly kind: 'changed'; readonly state: SellerCultureState; readonly reopened: boolean }
  | { readonly kind: 'unchanged'; readonly state: SellerCultureState };

/**
 * A membership the system approves at once at signup, for a culture with no required certification
 * type (ADR-0048). Never for a certified culture: that waits for a reviewer.
 */
export function approveAtSignup(request: MembershipRequest): SellerCultureState {
  return {
    sellerId: request.sellerId,
    cultureId: request.cultureId,
    cultureCode: request.cultureCode,
    status: 'approved',
    reason: null,
    requestedBy: null,
    requestedAt: request.at,
    decidedBy: null,
    decidedAt: request.at,
    version: 1,
    updatedAt: request.at,
  };
}

/**
 * A new request, or a request again after a rejection. A request that is waiting, or an approved
 * membership, is left as it is (a repeat is not an error: the signup step may be retried).
 */
export function requestMembership(
  existing: SellerCultureState | null,
  request: MembershipRequest,
): RequestOutcome {
  if (existing !== null && existing.status !== 'rejected') {
    return { kind: 'unchanged', state: existing };
  }
  const state: SellerCultureState = {
    sellerId: request.sellerId,
    cultureId: request.cultureId,
    cultureCode: existing?.cultureCode ?? request.cultureCode,
    status: 'requested',
    reason: null,
    requestedBy: request.by,
    requestedAt: request.at,
    decidedBy: null,
    decidedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: request.at,
  };
  return { kind: 'changed', state, reopened: existing !== null };
}

export interface MembershipDecision {
  readonly decision: 'approve' | 'reject';
  readonly reason: string | null;
  /** Null only for the system's approval at signup. */
  readonly by: Id<'Account'> | null;
  readonly at: Temporal.Instant;
}

export type DecisionRefusal =
  | { readonly code: 'culture.not-requested' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly CultureFieldProblem[];
    };

/** Approves or rejects a request that is waiting; a rejection needs a reason. */
export function decideMembership(
  state: SellerCultureState,
  decision: MembershipDecision,
): Result<SellerCultureState, DecisionRefusal> {
  if (state.status !== 'requested') return err({ code: 'culture.not-requested' });
  if (decision.decision === 'reject' && decision.reason === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'reason', code: 'required' }] });
  }
  return ok({
    ...state,
    status: decision.decision === 'approve' ? 'approved' : 'rejected',
    reason: decision.reason,
    decidedBy: decision.by,
    decidedAt: decision.at,
    version: state.version + 1,
    updatedAt: decision.at,
  });
}

/** Control, format and separator characters other than a plain space: never part of a reason. */
const HIDDEN_OR_CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

/** A plain object body; `problems` lists the keys that are not allowed (a closed body). */
function objectBody(
  body: unknown,
  allowed: readonly string[],
): Result<
  { record: Record<string, unknown>; problems: CultureFieldProblem[] },
  CultureFieldProblem[]
> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err([{ path: '', code: 'type' }]);
  }
  const problems = Object.keys(body)
    .sort()
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ path: key.slice(0, 64), code: 'unknown-field' }));
  return ok({ record: body as Record<string, unknown>, problems });
}

/** The body of a request: `{ cultureIds }`, 1 to 20 distinct ids. Codes and paths only. */
export function parseCultureIds(
  body: unknown,
): Result<readonly Id<'Culture'>[], readonly CultureFieldProblem[]> {
  const parsedBody = objectBody(body, ['cultureIds']);
  if (!parsedBody.ok) return parsedBody;
  if (parsedBody.value.problems.length > 0) return err(parsedBody.value.problems);
  const raw = parsedBody.value.record['cultureIds'];
  if (!Array.isArray(raw)) return err([{ path: 'cultureIds', code: 'type' }]);
  if (raw.length < 1 || raw.length > CULTURES_PER_REQUEST_MAX) {
    return err([{ path: 'cultureIds', code: 'length' }]);
  }
  const problems: CultureFieldProblem[] = [];
  const ids: Id<'Culture'>[] = [];
  (raw as unknown[]).forEach((value, index) => {
    const parsed = typeof value === 'string' ? parseId<'Culture'>(value) : null;
    if (parsed === null || !parsed.ok)
      problems.push({ path: `cultureIds.${index}`, code: 'format' });
    else if (ids.includes(parsed.value))
      problems.push({ path: `cultureIds.${index}`, code: 'duplicate' });
    else ids.push(parsed.value);
  });
  return problems.length > 0 ? err(problems) : ok(ids);
}

/**
 * The body of a decision: `{ decision: 'approve' | 'reject', reason? }`. A reason is 1 to 300
 * characters (trimmed, no control characters); whether a rejection needs one is
 * {@link decideMembership}'s rule.
 */
export function parseDecision(
  body: unknown,
): Result<
  { readonly decision: 'approve' | 'reject'; readonly reason: string | null },
  readonly CultureFieldProblem[]
> {
  const parsedBody = objectBody(body, ['decision', 'reason']);
  if (!parsedBody.ok) return parsedBody;
  const problems: CultureFieldProblem[] = [...parsedBody.value.problems];
  const { decision, reason } = parsedBody.value.record;
  if (decision !== 'approve' && decision !== 'reject')
    problems.push({ path: 'decision', code: 'unknown' });
  let text: string | null = null;
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string') problems.push({ path: 'reason', code: 'type' });
    else {
      const trimmed = reason.trim();
      if (trimmed.length < 1 || trimmed.length > CULTURE_DECISION_REASON_MAX) {
        problems.push({ path: 'reason', code: 'length' });
      } else if (HIDDEN_OR_CONTROL.test(trimmed.replace(/ /g, ''))) {
        problems.push({ path: 'reason', code: 'characters' });
      } else text = trimmed;
    }
  }
  if (problems.length > 0) return err(problems);
  return ok({ decision: decision as 'approve' | 'reject', reason: text });
}

/** What a seller chose at signup: every Active culture ("universal", the default) or a list of codes. */
export type SignupSelection =
  { readonly kind: 'universal' } | { readonly kind: 'codes'; readonly codes: readonly string[] };

/**
 * Reads the selection of a signup (ADR-0048): nothing, or the word `universal`, is every Active
 * culture; an array is an explicit list of 1 to 20 distinct culture codes. An empty list is refused
 * (`empty`), never read as "all". Whether a code is an Active culture of the Market is the use
 * case's check. Codes and paths only.
 */
export function parseSignupSelection(
  raw: unknown,
): Result<SignupSelection, readonly CultureFieldProblem[]> {
  if (raw === undefined || raw === null || raw === 'universal') return ok({ kind: 'universal' });
  if (!Array.isArray(raw)) return err([{ path: 'cultures', code: 'type' }]);
  if (raw.length === 0) return err([{ path: 'cultures', code: 'empty' }]);
  if (raw.length > CULTURES_PER_REQUEST_MAX) return err([{ path: 'cultures', code: 'length' }]);
  const problems: CultureFieldProblem[] = [];
  const codes: string[] = [];
  (raw as unknown[]).forEach((value, index) => {
    if (typeof value !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) || value.length > 40) {
      problems.push({ path: `cultures.${index}`, code: 'format' });
    } else if (codes.includes(value)) {
      problems.push({ path: `cultures.${index}`, code: 'duplicate' });
    } else codes.push(value);
  });
  return problems.length > 0 ? err(problems) : ok({ kind: 'codes', codes });
}
