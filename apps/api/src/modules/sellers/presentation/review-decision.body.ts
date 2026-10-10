import { isRecord, unknownFields, type FieldProblem } from './my-file.body';

// The shape checks of the reviewer's decision routes (sellers design 6.2, 8.3): a closed set of
// fields and their JSON types only. The ids are parsed and the reason's length is bounded by the
// use case; a value is never echoed.

/** The body of `POST …/review/approve`: revision N only. */
export function parseApproveBody(
  body: unknown,
): { readonly revisionId: string } | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ['revisionId']);
  const revisionId = requiredString(body, 'revisionId', problems);
  return problems.length > 0 ? problems : { revisionId: revisionId! };
}

/** The body of `POST …/review/reject`: revision N and the reason. */
export function parseRejectBody(
  body: unknown,
): { readonly revisionId: string; readonly reason: string } | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ['revisionId', 'reason']);
  const revisionId = requiredString(body, 'revisionId', problems);
  const reason = requiredString(body, 'reason', problems);
  return problems.length > 0 ? problems : { revisionId: revisionId!, reason: reason! };
}

/** The body of `PUT …/review/manual-register-check`: revision N and what the register showed. */
export function parseManualCheckBody(
  body: unknown,
): { readonly revisionId: string; readonly observedOutcome: string } | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ['revisionId', 'observedOutcome']);
  const revisionId = requiredString(body, 'revisionId', problems);
  const observedOutcome = requiredString(body, 'observedOutcome', problems);
  return problems.length > 0
    ? problems
    : { revisionId: revisionId!, observedOutcome: observedOutcome! };
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  problems: FieldProblem[],
): string | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (value === undefined) problems.push({ path: key, code: 'required' });
  else if (typeof value !== 'string') problems.push({ path: key, code: 'type' });
  else return value;
  return undefined;
}
