import 'server-only';
import type { ReviewStanding } from '../catalog/types.ts';
import { serverGet } from './server-fetch.ts';

/**
 * The seller's probation progress for the bar. Any failure is `null`: the page then shows no bar
 * (never a guessed one), and the page itself still works.
 */
export async function loadReviewStanding(): Promise<ReviewStanding | null> {
  const result = await serverGet<ReviewStanding>('catalog/seller/review-standing', {
    timeoutMs: 2000,
  });
  if (result.kind !== 'ok') return null;
  const { status, count, target, restarted } = result.body;
  if (status !== 'probation' && status !== 'trusted') return null;
  if (!Number.isInteger(count) || !Number.isInteger(target) || count < 0 || target < 1) {
    return status === 'trusted' ? { status, count: 0, target: 0, restarted: false } : null;
  }
  return { status, count, target, restarted: restarted === true };
}
