import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'settings.conflict': 'conflict',
  'access.denied': 'denied',
  'access.acting-as-refused': 'acting-as',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
  'second-factor.required': 'second-factor',
  'second-factor.enrolment-required': 'second-factor',
};

/** The message key (under `ai-gateway.error`) for a failed call. */
export function gatewayProblemOf(failure: ApiFailure): string {
  const fields = failure.details?.fields ?? [];
  if (failure.code === 'validation.failed') {
    if (fields.some((field) => field.path === 'version' && field.code === 'same')) return 'same';
    if (fields.some((field) => field.path === 'version')) return 'version';
    if (fields.some((field) => field.path === 'ai-cap-buyer-chat-day')) return 'chat-pair';
  }
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 429) return 'throttled';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
