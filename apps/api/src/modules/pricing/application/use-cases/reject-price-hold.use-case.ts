import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_HOLD_DECIDE } from '../../contracts/permissions';
import { PriceHoldRejected } from '../../domain/audit';
import {
  HOLD_REJECTION_REASONS,
  type HoldRejectionReason,
  type RegularPriceRecord,
} from '../../domain/price-series';
import {
  decideHold,
  type HoldDecisionDependencies,
  type HoldDecisionFailure,
} from '../hold-decision';
import { parseRecordId } from '../hold-review';

export interface RejectPriceHoldInput {
  readonly recordId: string;
  /** One of {@link HOLD_REJECTION_REASONS}; required (brief s9). */
  readonly reasonCode: string;
  /** Optional free text, 1 to 1000 characters after trimming; null or absent for none. */
  readonly note?: string | null;
}

export interface RejectPriceHoldOutput {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly outcome: 'rejected';
  readonly seriesVersion: number;
}

export type RejectPriceHoldDependencies = HoldDecisionDependencies;

/**
 * Whether a code point is one the table's `decision_note_check` refuses: every control character
 * but a newline (U+0000 to U+0009, U+000B to U+001F, U+007F to U+009F) and the bidirectional
 * marks (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069).
 */
function forbiddenInNote(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}
/** A half of a surrogate pair: PostgreSQL cannot store it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const MAX_NOTE_CHARACTERS = 1000;

/**
 * `pricing.reject-price-hold` (pricing design 3.1 row 4, 5.2, 8). Rule
 * `permissions [pricing.price-hold.decide]` (protected, platform scope), the same decider rule as
 * an approval (H4). A reason code from the closed list is required; the optional note is personal
 * free text: it goes on the record the seller reads (Q4) and never into an audit row, an event or
 * a log. The previous price is untouched.
 */
export class RejectPriceHold extends UseCase<
  RejectPriceHoldInput,
  RejectPriceHoldOutput,
  HoldDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.reject-price-hold',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_DECIDE.key] },
  };

  readonly #logger = new Logger('RejectPriceHold');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RejectPriceHoldDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RejectPriceHoldInput,
  ): Promise<Result<RejectPriceHoldOutput, HoldDecisionFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fields: { path: string; code: string }[] = [];
    const recordId = parseRecordId(input?.recordId);
    if (recordId === null) fields.push({ path: 'recordId', code: 'format' });
    const reason: unknown = input?.reasonCode;
    const reasonCode = HOLD_REJECTION_REASONS.find((r) => r === reason);
    if (reasonCode === undefined) fields.push({ path: 'reasonCode', code: 'enum' });
    const note = normaliseNote(input?.note, fields);
    if (fields.length > 0 || recordId === null || reasonCode === undefined) {
      return err({ code: 'validation.failed', fields });
    }

    const decided = await decideHold(
      this.deps,
      context,
      recordId,
      (series, now) => {
        const rejected = series.rejectHold({
          recordId,
          decidedBy: actor.accountId,
          reasonCode,
          note,
          now,
        });
        return rejected.ok ? ok(rejected.value) : err(rejected.error);
      },
      async (series, record: RegularPriceRecord) => {
        const { id, offerId, variantId } = series.state;
        await this.deps.audit.record(
          context,
          PriceHoldRejected.entry(id, {
            // The reason code only: the note is personal and stays on the record (design 8).
            after: {
              offerId,
              variantId,
              recordId: record.id,
              amount: record.amount,
              reasonCode: reasonCode satisfies HoldRejectionReason,
            },
          }),
        );
      },
    );
    this.#logger.log({
      msg: 'pricing.reject-price-hold',
      outcome: decided.ok ? 'rejected' : decided.error.code,
      recordId,
      accountId: actor.accountId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    if (!decided.ok) return decided;
    return ok({
      recordId,
      outcome: 'rejected',
      seriesVersion: decided.value.series.state.version,
    });
  }
}

/** Trimmed text of 1 to 1000 characters without forbidden characters, or null for none. */
function normaliseNote(value: unknown, fields: { path: string; code: string }[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    fields.push({ path: 'note', code: 'type' });
    return null;
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (Array.from(text).length > MAX_NOTE_CHARACTERS) {
    fields.push({ path: 'note', code: 'length' });
    return null;
  }
  if (
    LONE_SURROGATE.test(text) ||
    Array.from(text).some((c) => forbiddenInNote(c.codePointAt(0) ?? 0))
  ) {
    fields.push({ path: 'note', code: 'format' });
    return null;
  }
  return text;
}
