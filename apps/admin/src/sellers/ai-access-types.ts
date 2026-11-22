// The seller AI switch read (GET sellers/admin/:sellerId/ai-access). Plain module, no 'use client':
// the seller page (a server component) calls these, and a server file may only render what a
// client module exports, never call it.
export const aiAccessPath = (sellerId: string): string => `sellers/admin/${sellerId}/ai-access`;

/** What `GET sellers/admin/:id/ai-access` answers; `changedAt` is null until an admin changes it. */
export interface AiAccessRead {
  readonly enabled: boolean;
  readonly changedAt: string | null;
}

/** The read checked; anything else is treated as unreadable. */
export function aiAccessOf(value: unknown): AiAccessRead | null {
  if (typeof value !== 'object' || value === null) return null;
  const { enabled, changedAt } = value as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return null;
  return { enabled, changedAt: typeof changedAt === 'string' ? changedAt : null };
}
