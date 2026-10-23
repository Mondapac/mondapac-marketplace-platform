// The storefront BFF's two calls to identity's seller sign-up routes (PR #443): `POST
// identity/seller/sign-up` and `POST identity/seller/verification-email`. The API takes them from
// the storefront only when the request is same-origin from the Market's storefront origin and its
// client address is proved under a storefront key (ADR-0037), so this side sends exactly that.
// Answers are mapped to invalid, throttled or failed only; no API text reaches the page, and
// nothing personal is logged (Hassan, PR #442).
import 'server-only';
import {
  CLIENT_ADDRESS_HEADER,
  MissingClientAddressError,
  signForRequest,
  type ClientAddressKey,
} from '@mondapac/panel-server';
import type { StorefrontHost } from './config.ts';
import type { SellerSignUpAnswer, SellerSignUpField, SellerSignUpFieldError } from './types.ts';

export type SellerSignUpRoute = 'sign-up' | 'verification-email';

export interface SellerSignUpCall {
  readonly apiBaseUrl: string;
  /** Required here: the API takes these routes from the storefront only with a proved address. */
  readonly clientAddressKey: ClientAddressKey;
  readonly host: StorefrontHost;
  /** The incoming request's headers; only `x-mp-client-address` (set by server.mjs) is read. */
  readonly incoming: { get(name: string): string | null };
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: Record<string, string | number>) => void;
}

const TIMEOUT_MS = 10_000;
const RETRY_DEFAULT_SECONDS = 60;
const RETRY_MAX_SECONDS = 3600;

const stdoutLog = (line: Record<string, string | number>): void =>
  console.log(JSON.stringify(line));

/** The headers the API's storefront allowance checks, plus the Market and the signed address. */
export function signUpHeaders(call: SellerSignUpCall): Headers {
  const now = call.now ?? Date.now;
  return new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    origin: call.host.origin,
    'sec-fetch-site': 'same-origin',
    'x-market-id': call.host.marketId,
    [CLIENT_ADDRESS_HEADER]: signForRequest({
      key: call.clientAddressKey,
      marketId: call.host.marketId,
      headers: call.incoming,
      nowSeconds: Math.floor(now() / 1000),
    }),
  });
}

interface ApiError {
  readonly code?: unknown;
  readonly details?: {
    readonly fields?: unknown;
    readonly rule?: unknown;
    readonly retryAfterSeconds?: unknown;
  };
}

const NAME_CODES: Readonly<Record<string, SellerSignUpFieldError>> = {
  required: 'required',
  length: 'name-length',
  characters: 'name-characters',
};
const EMAIL_CODES: Readonly<Record<string, SellerSignUpFieldError>> = {
  required: 'required',
  format: 'email-format',
};
const PASSWORD_RULES: Readonly<Record<string, SellerSignUpFieldError>> = {
  common: 'password-common',
  'contains-identity': 'password-identity',
};

/** `validation.failed` fields mapped to the form's own; null when any is not the form's. */
function fieldErrors(fields: unknown): SellerSignUpAnswer | null {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const mapped: Partial<Record<SellerSignUpField, SellerSignUpFieldError>> = {};
  for (const field of fields as Array<{ path?: unknown; code?: unknown }>) {
    const code = typeof field?.code === 'string' ? field.code : '';
    const error =
      field?.path === 'displayName'
        ? NAME_CODES[code]
        : field?.path === 'email'
          ? EMAIL_CODES[code]
          : field?.path === 'password' && code === 'required'
            ? 'required'
            : undefined;
    if (error === undefined) return null;
    const key: SellerSignUpField =
      field.path === 'displayName' ? 'name' : (field.path as SellerSignUpField);
    mapped[key] ??= error;
  }
  return { kind: 'invalid', fields: mapped };
}

function retryAfter(body: ApiError | null, header: string | null): number {
  const raw = body?.details?.retryAfterSeconds ?? Number(header);
  const seconds = typeof raw === 'number' && Number.isFinite(raw) ? Math.ceil(raw) : NaN;
  if (!(seconds > 0)) return RETRY_DEFAULT_SECONDS;
  return Math.min(seconds, RETRY_MAX_SECONDS);
}

/**
 * Maps an API answer. 202 is accepted (the same for every address, AC 21); 429 throttled; a 400
 * the form can show is invalid; everything else, `request.busy`, `request.csrf` and
 * `access.unavailable` included, is failed.
 */
export function mapSignUpAnswer(
  route: SellerSignUpRoute,
  status: number,
  body: ApiError | null,
  retryAfterHeader: string | null,
  password?: { readonly typed: string; readonly maxLength: number },
): SellerSignUpAnswer {
  if (status === 202) return { kind: 'accepted' };
  if (status === 429)
    return { kind: 'throttled', retryAfterSeconds: retryAfter(body, retryAfterHeader) };
  if (status !== 400 || route !== 'sign-up') return { kind: 'failed' };
  if (body?.code === 'validation.failed')
    return fieldErrors(body.details?.fields) ?? { kind: 'failed' };
  if (body?.code === 'password.rejected') {
    const rule = body.details?.rule;
    if (rule === 'length' && password !== undefined) {
      const length = [...password.typed.normalize('NFKC')].length;
      return {
        kind: 'invalid',
        fields: { password: length > password.maxLength ? 'password-long' : 'password-short' },
      };
    }
    const error = typeof rule === 'string' ? PASSWORD_RULES[rule] : undefined;
    if (error !== undefined) return { kind: 'invalid', fields: { password: error } };
  }
  return { kind: 'failed' };
}

/** Sends one call and maps its answer; a network error, a timeout or a missing address is failed. */
export async function callSellerSignUp(
  call: SellerSignUpCall,
  route: SellerSignUpRoute,
  body: Readonly<Record<string, string>>,
  password?: { readonly typed: string; readonly maxLength: number },
): Promise<SellerSignUpAnswer> {
  const log = call.log ?? stdoutLog;
  const send = call.fetch ?? fetch;
  try {
    const response = await send(`${call.apiBaseUrl}/identity/seller/${route}`, {
      method: 'POST',
      headers: signUpHeaders(call),
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let parsed: ApiError | null = null;
    if (response.status !== 202) {
      parsed = (await response.json().catch(() => null)) as ApiError | null;
    }
    const answer = mapSignUpAnswer(
      route,
      response.status,
      parsed,
      response.headers.get('retry-after'),
      password,
    );
    if (answer.kind === 'failed') {
      log({
        msg: 'storefront.seller-sign-up.failed',
        route,
        status: response.status,
        code: typeof parsed?.code === 'string' ? parsed.code : '',
        marketId: call.host.marketId,
        correlationId: response.headers.get('x-correlation-id') ?? '',
      });
    }
    return answer;
  } catch (error) {
    log({
      msg: 'storefront.seller-sign-up.unreachable',
      route,
      // A missing address means the request did not come through server.mjs; never sent unsigned.
      reason:
        error instanceof MissingClientAddressError
          ? 'client-address-missing'
          : error instanceof Error
            ? error.name
            : 'unknown',
      marketId: call.host.marketId,
    });
    return { kind: 'failed' };
  }
}
