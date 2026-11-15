import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type {
  AppliedChange,
  PolicyArea,
  RecordedRequest,
  RecordFailure,
  Risk,
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

const requestId = (n: number): Id<'SystemRequest'> => {
  const parsed = parseId(
    `01990000-0000-7000-8000-${(0x5e0000 + n).toString(16).padStart(12, '0')}`,
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'SystemRequest'>;
};
