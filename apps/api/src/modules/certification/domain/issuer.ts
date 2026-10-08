import { err, ok, type Result } from '@mondapac/shared-kernel';
import { assertSecondAdmin } from './type-revision';

export type IssuerState = 'proposed' | 'active' | 'closed-to-new' | 'derecognised';

/** Who confirmed the issuer, when, and a document or note reference (brief s5, AC 19). */
export interface ExpertApproval {
  readonly confirmedBy: string;
  readonly reference: string;
}

export interface IssuerRecord {
  readonly state: IssuerState;
  readonly expertApproval: ExpertApproval | null;
  /** Set while a reactivation waits for a second admin (design 3.5; H1). */
  readonly reactivation: {
    readonly requestedBy: string;
    readonly expertApproval: ExpertApproval;
  } | null;
}

export type IssuerProblem =
  | {
      readonly code: 'issuer.transition-forbidden';
      readonly from: IssuerState;
      readonly to: string;
    }
  | { readonly code: 'issuer.expert-approval-required' }
  | { readonly code: 'issuer.expert-approval-not-new' }
  | { readonly code: 'issuer.confirmation-count-mismatch' }
  | { readonly code: 'issuer.reactivation-not-requested' }
  | { readonly code: 'issuer.reactivation-pending' }
  | { readonly code: 'approval.same-admin' };

const approvalValid = (a: ExpertApproval | null | undefined): a is ExpertApproval =>
  a !== null && a !== undefined && cleanText(a.confirmedBy) && cleanText(a.reference);

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
const refKey = (r: string): string =>
  r
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\p{Pd}/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
const cleanText = (s: unknown): s is string =>
  typeof s === 'string' && s.trim().length > 0 && !new RegExp(INVISIBLE.source, 'u').test(s);
const sameReference = (a: string, b: string | undefined): boolean =>
  b !== undefined && refKey(a) === refKey(b);

const forbidden = (from: IssuerState, to: string): Result<never, IssuerProblem> =>
  err({ code: 'issuer.transition-forbidden', from, to });

export const newIssuer = (): IssuerRecord => ({
  state: 'proposed',
  expertApproval: null,
  reactivation: null,
});

/** `proposed` → `active`, only with an expert-approval reference. */
export function activate(
  i: IssuerRecord,
  approval: ExpertApproval,
): Result<IssuerRecord, IssuerProblem> {
  if (i.state !== 'proposed') return forbidden(i.state, 'active');
  if (!approvalValid(approval)) return err({ code: 'issuer.expert-approval-required' });
  return ok({ state: 'active', expertApproval: approval, reactivation: null });
}

/** `active` → `closed-to-new`; approved certificates stay valid until their own boundary. */
export function closeToNew(i: IssuerRecord): Result<IssuerRecord, IssuerProblem> {
  if (i.state !== 'active') return forbidden(i.state, 'closed-to-new');
  return ok({ ...i, state: 'closed-to-new' });
}

/**
 * `active` or `closed-to-new` → `derecognised` (terminal). The admin's confirmation names the
 * number of affected approved certificates; a stale count is refused (brief s12).
 */
export function derecognise(
  i: IssuerRecord,
  confirmedAffectedCount: number,
  actualAffectedCount: number,
): Result<IssuerRecord, IssuerProblem> {
  if (i.state !== 'active' && i.state !== 'closed-to-new')
    return forbidden(i.state, 'derecognised');
  if (
    !Number.isSafeInteger(confirmedAffectedCount) ||
    confirmedAffectedCount < 0 ||
    confirmedAffectedCount !== actualAffectedCount
  ) {
    return err({ code: 'issuer.confirmation-count-mismatch' });
  }
  return ok({ ...i, state: 'derecognised', reactivation: null });
}

/** `closed-to-new` → request to reactivate, with a new expert reference (H1). */
export function requestReactivation(
  i: IssuerRecord,
  requestedBy: string,
  approval: ExpertApproval,
): Result<IssuerRecord, IssuerProblem> {
  if (i.state !== 'closed-to-new') return forbidden(i.state, 'active');
  if (i.reactivation !== null) return err({ code: 'issuer.reactivation-pending' });
  if (!approvalValid(approval)) return err({ code: 'issuer.expert-approval-required' });
  if (!cleanText(requestedBy)) return err({ code: 'approval.same-admin' });
  if (sameReference(approval.reference, i.expertApproval?.reference)) {
    return err({ code: 'issuer.expert-approval-not-new' });
  }
  return ok({
    ...i,
    reactivation: {
      requestedBy,
      expertApproval: { ...approval, reference: approval.reference.trim() },
    },
  });
}

/** A second admin, not the requester, approves; the issuer stays `closed-to-new` until then. */
export function approveReactivation(
  i: IssuerRecord,
  approverAccountId: string,
): Result<IssuerRecord, IssuerProblem> {
  if (i.state !== 'closed-to-new') return forbidden(i.state, 'active');
  if (i.reactivation === null) return err({ code: 'issuer.reactivation-not-requested' });
  const second = assertSecondAdmin(i.reactivation.requestedBy, approverAccountId);
  if (!second.ok) return err(second.error);
  return ok({ state: 'active', expertApproval: i.reactivation.expertApproval, reactivation: null });
}

/** An issuer may name a certificate only in the allow-listed states (design 2.4). */
export const acceptsNewCertificates = (state: IssuerState): boolean => state === 'active';
