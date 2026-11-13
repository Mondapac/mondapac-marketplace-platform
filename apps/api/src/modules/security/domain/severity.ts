/** Plan section 4: s1 critical (24/7), s2 high, s3 medium, s4 low (the security event scale). */
export const SEVERITIES = ['s1', 's2', 's3', 's4'] as const;

export type SecuritySeverity = (typeof SEVERITIES)[number];

export function isSeverity(value: unknown): value is SecuritySeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}
