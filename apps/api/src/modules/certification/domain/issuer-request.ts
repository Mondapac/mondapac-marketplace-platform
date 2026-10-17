import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { TypeSettings } from './seller-certificate';
import type { IssuerState } from './validity';

// "My issuer is not listed" (certification design 2.1 `IssuerRequest`, 3.3, 7.2; brief s4 a 3,
// AC 11). A seller of a registry type whose issuer is missing sends the issuer's name as they
// typed it, with a file; an admin of the Market answers it: the issuer was added (the admin created
// it in the registry on its own path) or not accepted (a reason code of the Market). The typed name
// is request text only: there is no path from it to an `Issuer`, a draft or a submission, and the
// answer carries no name at all. Pure: no clock, no store.

export const ISSUER_REQUEST_STATES = ['open', 'issuer-added', 'not-accepted'] as const;
export type IssuerRequestState = (typeof ISSUER_REQUEST_STATES)[number];

export const ISSUER_REQUEST_OUTCOMES = ['issuer-added', 'not-accepted'] as const;
export type IssuerRequestOutcome = (typeof ISSUER_REQUEST_OUTCOMES)[number];

/** The longest issuer name a seller may type (characters, after trimming). */
export const MAX_TYPED_ISSUER_NAME_LENGTH = 200;
/** Files one request carries: one, sent with it (the route takes one file per request). */
export const ISSUER_REQUEST_DOCUMENTS = 1;

/**
 * The typed name as stored (encrypted): trimmed, 1 to 200 characters, plain text without control
 * or format characters. It is never normalised into a registry key and never compared with one.
 */
export function parseTypedIssuerName(value: unknown): Result<string, { readonly code: string }> {
  if (value === undefined || value === null) return err({ code: 'required' });
  if (typeof value !== 'string') return err({ code: 'type' });
  const text = value.trim();
  if (text.length === 0) return err({ code: 'required' });
  if (Array.from(text).length > MAX_TYPED_ISSUER_NAME_LENGTH) return err({ code: 'too-long' });
  if (!parsePlainText(text).ok) return err({ code: 'invalid-character' });
  return ok(text);
}

export type IssuerRequestTypeRefusal =
  { readonly code: 'type.inactive' } | { readonly code: 'type.no-issuer-registry' };

/**
 * Whether a seller may ask for a missing issuer of this type: only an active type whose form takes
 * the issuer from the registry (a type without a registry has nothing to be missing from).
 */
export function issuerRequestTypeRefusal(type: TypeSettings): IssuerRequestTypeRefusal | null {
  if (type.status !== 'active') return { code: 'type.inactive' };
  if (!type.requiresIssuerRegistry) return { code: 'type.no-issuer-registry' };
  return null;
}

/** The answer an admin gives; the issuer id and the reason code are the only inputs it has. */
export type IssuerRequestAnswerChoice =
  | { readonly outcome: 'issuer-added'; readonly issuerId: Id<'Issuer'> }
  | { readonly outcome: 'not-accepted'; readonly reasonCode: string };

/** The issuer an `issuer-added` answer names, as the registry holds it. */
export interface AnsweredIssuer {
  readonly typeId: Id<'CertificationType'>;
  readonly state: IssuerState;
}

export type IssuerRequestAnswerRefusal =
  | { readonly code: 'issuer-request.already-answered' }
  | { readonly code: 'issuer.not-found' }
  | { readonly code: 'issuer.not-active' }
  | { readonly code: 'issuer-request.reason-unknown' };

/**
 * The guard of an answer (design 2.1, 3.5): only an `open` request is answered, once. An
 * `issuer-added` answer names an `active` issuer of the request's own type (an issuer of another
 * type is the same `issuer.not-found` as an unknown one, so the answer never links two types);
 * a `not-accepted` answer gives a reason code of the Market's list.
 */
export function answerRefusal(input: {
  readonly state: IssuerRequestState;
  readonly typeId: Id<'CertificationType'>;
  readonly answer: IssuerRequestAnswerChoice;
  readonly issuer: AnsweredIssuer | null;
  readonly reasonCodes: readonly string[];
}): IssuerRequestAnswerRefusal | null {
  if (input.state !== 'open') return { code: 'issuer-request.already-answered' };
  if (input.answer.outcome === 'issuer-added') {
    if (input.issuer === null || input.issuer.typeId !== input.typeId) {
      return { code: 'issuer.not-found' };
    }
    if (input.issuer.state !== 'active') return { code: 'issuer.not-active' };
    return null;
  }
  if (!input.reasonCodes.includes(input.answer.reasonCode)) {
    return { code: 'issuer-request.reason-unknown' };
  }
  return null;
}
