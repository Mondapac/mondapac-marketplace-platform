/**
 * The per-subject message counters (package 1's PostgreSQL counters, class `assistant-message`,
 * fixed 10-minute windows). The subject string names its kind and Market; it is hashed before it
 * is stored. A counter that cannot be read rejects, and the turn fails closed.
 */
export interface MessageLimits {
  count(subject: string): Promise<{ readonly count: number; readonly retryAfterSeconds: number }>;
}

export const MESSAGE_LIMITS = Symbol('MESSAGE_LIMITS');
