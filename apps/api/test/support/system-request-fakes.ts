import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type {
  AppliedChange,
  PolicyArea,
  ProposedChange,
  ProposeFailure,
  RecordedRequest,
  RecordFailure,
  Risk,
  SystemActionProposer,
  SystemRequestRecorder,
} from '../../src/modules/system-requests';

/**
 * System requests' recorder in memory, for a module that opens reviews of its changes. Each area
 * is off unless `review(area)` switches it on; an opening in a reviewed area checks the note as
 * the real recorder does (1 to 500 characters) and keeps the change in `opened`. `failNext`
 * makes the next opening answer `access.denied`, to show the caller rolls its own change back.
 */
export class RecordingReview implements SystemRequestRecorder {
  readonly opened: AppliedChange[] = [];
  readonly asked: PolicyArea[] = [];
  failNext = false;
  private readonly reviewed = new Map<PolicyArea, Risk>();
  private counter = 0;

  review(area: PolicyArea, risk: Risk = 'low'): this {
    this.reviewed.set(area, risk);
    return this;
  }

  /** Every area off again, and nothing opened or asked (a shared fake between tests). */
  reset(): void {
    this.reviewed.clear();
    this.opened.length = 0;
    this.asked.length = 0;
    this.failNext = false;
    this.counter = 0;
  }

  /** Whether the area is switched on (for the proposer fake that shares this policy). */
  isReviewed(area: PolicyArea): Risk | undefined {
    return this.reviewed.get(area);
  }

  areaPolicy(
    _context: CallContext,
    area: PolicyArea,
  ): Promise<{ readonly enabled: boolean; readonly risk: Risk }> {
    this.asked.push(area);
    const risk = this.reviewed.get(area);
    return Promise.resolve({ enabled: risk !== undefined, risk: risk ?? 'low' });
  }

  openReview(
    _context: CallContext,
    change: AppliedChange,
  ): Promise<Result<RecordedRequest | null, RecordFailure>> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    const risk = this.reviewed.get(change.area);
    if (risk === undefined) return Promise.resolve(ok(null));
    // As the real recorder does: a change whose values did not change opens nothing.
    if (stable(change.before) === stable(change.after)) return Promise.resolve(ok(null));
    const note = typeof change.note === 'string' ? change.note.trim() : '';
    if (note.length === 0 || note.length > 500) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] }),
      );
    }
    this.opened.push(change);
    this.counter += 1;
    return Promise.resolve(
      ok({
        id: requestId(this.counter),
        number: this.counter,
        risk: change.risk ?? risk,
        reviewDueAt: Temporal.Instant.from('2026-11-08T10:00:00Z'),
      }),
    );
  }
}

/**
 * System requests' action proposer in memory (approval mode), sharing the area policy of a
 * {@link RecordingReview}. An area that is off answers `ok(null)` (the caller applies at once);
 * otherwise the proposal is kept in `proposed`, checked as the real proposer does (note 1 to 500
 * characters, one waiting proposal per subject: `system-requests.already-pending`). `settle(ref)`
 * frees a subject again (an approval, rejection or withdrawal).
 */
export class RecordingProposer implements SystemActionProposer {
  readonly proposed: ProposedChange[] = [];
  private readonly pending = new Map<string, number>();
  private counter = 0;

  constructor(private readonly policy: RecordingReview) {}

  reset(): void {
    this.proposed.length = 0;
    this.pending.clear();
    this.counter = 0;
  }

  settle(subjectKind: string, subjectRef: string): void {
    this.pending.delete(`${subjectKind}:${subjectRef}`);
  }

  proposeChange(
    _context: CallContext,
    change: ProposedChange,
  ): Promise<Result<RecordedRequest | null, ProposeFailure>> {
    const risk = this.policy.isReviewed(change.area);
    if (risk === undefined) return Promise.resolve(ok(null));
    const note = typeof change.note === 'string' ? change.note.trim() : '';
    if (note.length === 0 || note.length > 500) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] }),
      );
    }
    const key = `${change.subjectKind}:${change.subjectRef}`;
    const waiting = this.pending.get(key);
    if (waiting !== undefined) {
      return Promise.resolve(
        err({ code: 'system-requests.already-pending', pendingNumber: waiting }),
      );
    }
    this.counter += 1;
    this.pending.set(key, 900 + this.counter);
    this.proposed.push(change);
    return Promise.resolve(
      ok({
        id: requestId(0x900 + this.counter),
        number: 900 + this.counter,
        risk: change.risk ?? risk,
        reviewDueAt: Temporal.Instant.from('2026-11-08T10:00:00Z'),
      }),
    );
  }
}

/**
 * The output of an action that may wait for approval, when it was done at once (its area is off);
 * throws on a proposal (an answer holding only `request`).
 */
export function applied<V>(value: V): Exclude<V, OnlyRequest> {
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'request') throw new Error('sent for approval');
  }
  return value as Exclude<V, OnlyRequest>;
}

/** A proposal's answer: only the request filed (its `request` is never null). */
type OnlyRequest = { readonly request: { readonly id: unknown; readonly number: unknown } };

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

const requestId = (n: number): Id<'SystemRequest'> => {
  const parsed = parseId(
    `01990000-0000-7000-8000-${(0x5e0000 + n).toString(16).padStart(12, '0')}`,
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'SystemRequest'>;
};
