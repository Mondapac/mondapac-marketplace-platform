import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { TagClaimQuery, TagDecision } from '../../domain/offer-tag';
import {
  MAX_CLAIM_QUERIES_PER_CALL,
  type ClaimCheckUnavailable,
  type ClaimEvaluator,
} from '../ports/claim-evaluator';

/**
 * Asks `evaluateClaims` for every query of every type, outside any unit (catalog design 5.2 step
 * 1; PP 3.1 row 5), in calls of at most 100 queries (5.1 "Batches"). One failed call makes the
 * whole answer unavailable: there is no partial answer. The decisions come back per type in the
 * order of the queries; they are valid only for this request and are never kept.
 */
export async function askClaims(
  evaluator: ClaimEvaluator,
  context: CallContext,
  byType: ReadonlyMap<string, readonly TagClaimQuery[]>,
): Promise<Result<Map<string, readonly TagDecision[]>, ClaimCheckUnavailable>> {
  const flat: { readonly typeCode: string; readonly query: TagClaimQuery }[] = [];
  for (const [typeCode, queries] of byType) {
    for (const query of queries) flat.push({ typeCode, query });
  }
  const answers: TagDecision[] = [];
  for (let start = 0; start < flat.length; start += MAX_CLAIM_QUERIES_PER_CALL) {
    const batch = flat.slice(start, start + MAX_CLAIM_QUERIES_PER_CALL);
    const answer = await evaluator.evaluate(
      context,
      batch.map(({ query }) => query),
    );
    if (!answer.ok) return answer;
    if (answer.value.length !== batch.length) return err({ code: 'claim.check-unavailable' });
    answers.push(...answer.value);
  }
  const out = new Map<string, TagDecision[]>();
  for (const typeCode of byType.keys()) out.set(typeCode, []);
  flat.forEach(({ typeCode }, index) => out.get(typeCode)!.push(answers[index]!));
  return ok(out);
}
