// The seller blog switch read (GET sellers/admin/:sellerId/blog-access). Plain module, no
// 'use client': the seller page (a server component) calls these.
export const BLOG_ACCESS_PERMISSION = 'sellers.blog-access.edit';
export const blogAccessPath = (sellerId: string): string => `sellers/admin/${sellerId}/blog-access`;

/** What `GET sellers/admin/:id/blog-access` answers; `changedAt` is null until an admin changes it. */
export interface BlogAccessRead {
  readonly enabled: boolean;
  readonly changedAt: string | null;
}

/** The read checked; anything else is treated as unreadable. */
export function blogAccessOf(value: unknown): BlogAccessRead | null {
  if (typeof value !== 'object' || value === null) return null;
  const { enabled, changedAt } = value as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return null;
  return { enabled, changedAt: typeof changedAt === 'string' ? changedAt : null };
}
