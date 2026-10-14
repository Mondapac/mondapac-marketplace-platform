import { isRecord, unknownFields, type FieldProblem } from './my-file.body';

/** The body of `PUT store-settings/minimum-order` as the use case takes it. */
export interface MinimumOrderBody {
  readonly expectedVersion: number;
  readonly minimumOrder: { readonly amount: number; readonly currency: string } | null;
}

/**
 * Shape only (sellers design 18; 8.3): `expectedVersion` a JSON integer, `minimumOrder` null (clear)
 * or a closed `{ amount, currency }` whose amount is a JSON number and currency a string. What the
 * amount and currency mean (the Market's currency, above zero, at most the maximum) is the use
 * case's. A value is never echoed.
 */
export function parseMinimumOrderBody(body: unknown): MinimumOrderBody | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ['expectedVersion', 'minimumOrder']);
  const version = body.expectedVersion;
  if (version === undefined) problems.push({ path: 'expectedVersion', code: 'required' });
  else if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    problems.push({ path: 'expectedVersion', code: 'type' });
  }
  const value = body.minimumOrder;
  let minimumOrder: MinimumOrderBody['minimumOrder'] = null;
  if (value === undefined) problems.push({ path: 'minimumOrder', code: 'required' });
  else if (value !== null) {
    if (!isRecord(value)) problems.push({ path: 'minimumOrder', code: 'type' });
    else {
      for (const problem of unknownFields(value, ['amount', 'currency'])) {
        problems.push({ path: `minimumOrder.${problem.path}`, code: problem.code });
      }
      if (typeof value.amount !== 'number') {
        problems.push({
          path: 'minimumOrder.amount',
          code: value.amount === undefined ? 'required' : 'type',
        });
      }
      if (typeof value.currency !== 'string') {
        problems.push({
          path: 'minimumOrder.currency',
          code: value.currency === undefined ? 'required' : 'type',
        });
      }
      if (typeof value.amount === 'number' && typeof value.currency === 'string') {
        minimumOrder = { amount: value.amount, currency: value.currency };
      }
    }
  }
  return problems.length > 0 ? problems : { expectedVersion: version as number, minimumOrder };
}
