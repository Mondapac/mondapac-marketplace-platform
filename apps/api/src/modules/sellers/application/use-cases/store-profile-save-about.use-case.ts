import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { SELLERS_STORE_PROFILE_EDIT } from '../../contracts/permissions';
import { StoreProfileSaved } from '../../domain/audit';
import { StoreProfilePublished } from '../../domain/events';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import { derivedId } from '../../../../platform/hashing/derived-id';
import { parseAboutText } from '../../domain/store-about';
import { contentOf } from '../../domain/store-profile-content';
import { logDraftOutcome, reserveRateLimits, sellerActorOf } from '../draft/draft-support';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { StoreTextClaimCheck } from '../ports/store-text-claim-check';
import {
  loadStoreProfileView,
  storeProfileLogger,
  type StoreProfileReadDependencies,
  type StoreProfileView,
  type StoreProfileWriteFailure,
} from '../store-profile/store-profile';

/** The namespace of a store's profile aggregate id; never changed once events exist. */
const STORE_PROFILE_AGGREGATE_NAMESPACE = 'sellers.store-profile.aggregate.v1';

/** The request as the seller sends it: the version the page read and the text of each locale. */
export interface SaveAboutInput {
  readonly expectedVersion?: unknown;
  readonly about?: unknown;
}

export interface StoreProfileSaveAboutDependencies extends StoreProfileReadDependencies {
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly claimCheck: StoreTextClaimCheck;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `store-profile.save-about` (sellers design 3.7, 6.2 `my-store-profile.save`; slice 12 part 2):
 * the About text of each locale of the Market. Every save is a new revision that is public at once
 * (no review); rolling back is saving the old text again. Rule `permissions
 * [sellers.store-profile.edit]`, approved sellers only. In order: the seller is
 * `ActorContext.sellerId`; the saves limit of 6.5 is reserved; the shape is checked (the
 * expected version a whole number from 0; the texts keyed by locales the Market offers); each text
 * meets the About rules (`about.length`, `about.characters`, `about.url`: trimmed, at most 2000
 * characters, no control or bidi character, no link) and carries no certification claim term
 * (`about.claim-term`, from `certification.matchClaimTerms`, fail closed); the content is sealed
 * under the seller's key; then one read-write unit refuses a stale `expectedVersion`
 * (`conflict.stale`), inserts the revision, moves the published pointer, records
 * `sellers.store-profile.saved` and the event `sellers.store-profile-published.v1`. A save that
 * changes nothing writes nothing. Nothing of the text reaches a log, an event or an audit row; a
 * refusal names the locale and the rule, never a value or the term found.
 */
export class StoreProfileSaveAbout extends UseCase<
  SaveAboutInput,
  StoreProfileView,
  StoreProfileWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-profile-save-about',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreProfileSaveAboutDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SaveAboutInput,
  ): Promise<Result<StoreProfileView, StoreProfileWriteFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'store-profile-save-about',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: SaveAboutInput,
  ): Promise<Result<StoreProfileView, StoreProfileWriteFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;

    const reserved = await reserveRateLimits(deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const version = input.expectedVersion;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'expectedVersion', code: 'format' }],
      });
    }
    let locales: Awaited<ReturnType<typeof deps.localesPolicy.locales>>;
    try {
      locales = deps.localesPolicy.locales(market);
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    const checked = this.parseTexts(input.about, locales.supportedLocales);
    if (!checked.ok) return checked;
    const texts = checked.value;

    const flagged = await this.claimFields(context, texts);
    if (!flagged.ok) return flagged;
    if (flagged.value.length > 0) {
      return err({ code: 'validation.failed', fields: flagged.value });
    }

    const content = contentOf(Object.fromEntries(texts));
    let sealed: Awaited<ReturnType<typeof deps.contentSealer.seal>>;
    try {
      sealed = await deps.contentSealer.seal(market, owner.sellerId, content);
    } catch (error) {
      storeProfileLogger.error({
        msg: 'sellers.store-profile-save-about.seal-failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId: owner.sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
    if (!sealed.ok) return err({ code: 'sellers.unavailable' });

    const revisionId = deps.ids.next<'StoreProfileRevision'>();
    try {
      const written = await deps.unitOfWork.run<'saved' | 'unchanged', StoreProfileWriteFailure>(
        market,
        async () => {
          const settings = await deps.storeProfiles.find(market, owner.sellerId);
          if (settings === null) return err({ code: 'file.not-found' });
          if (!settings.approved) return err({ code: 'access.denied' });
          const published = await deps.storeContent.published(market, owner.sellerId);
          const current = published?.revisionNo ?? 0;
          if (current !== version) return err({ code: 'conflict.stale' });
          if (published !== null && published.contentHash === sealed.value.contentHash) {
            return ok('unchanged');
          }
          const now = deps.clock.now();
          const outcome = await deps.storeContent.publish(market, owner.sellerId, {
            id: revisionId,
            expectedRevisionNo: current,
            ciphertext: sealed.value.ciphertext,
            schemaVersion: content.schemaVersion,
            contentHash: sealed.value.contentHash,
            authorAccountId: owner.accountId,
            createdAt: now,
          });
          if (outcome === 'stale') return err({ code: 'conflict.stale' });
          if (outcome === 'no-profile') return err({ code: 'file.not-found' });
          await deps.audit.record(
            context,
            StoreProfileSaved.entry(owner.sellerId, {
              after: { revisionId, revisionNo: current + 1 },
            }),
          );
          await deps.outbox.append(context, [
            StoreProfilePublished.record({
              // A stable store-profile id derived from the seller id (never the seller id itself:
              // the outbox key (aggregate id, version) is unique and the seller id's versions
              // belong to the business file's events). The version is the revision number.
              aggregateId: derivedId<'StoreProfile'>(
                STORE_PROFILE_AGGREGATE_NAMESPACE,
                owner.sellerId,
              ),
              aggregateVersion: current + 1,
              occurredAt: now,
              payload: { sellerId: owner.sellerId, revisionId },
            }),
          ]);
          return ok('saved');
        },
      );
      if (!written.ok) return written;
    } catch (error) {
      storeProfileLogger.error({
        msg: 'sellers.store-profile-save-about.failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId: owner.sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
    return loadStoreProfileView(deps, context, owner);
  }

  /**
   * The texts by locale, each parsed. A shape or locale problem names its path; a text problem
   * names the locale path and the rule. The locale keys are the Market's, so a path never echoes
   * the client's own spelling.
   */
  private parseTexts(
    about: unknown,
    supported: readonly string[],
  ): Result<ReadonlyMap<string, string>, StoreProfileWriteFailure> {
    if (!isRecord(about)) {
      return err({ code: 'validation.failed', fields: [{ path: 'about', code: 'type' }] });
    }
    const fields: { path: string; code: string }[] = [];
    const texts = new Map<string, string>();
    if (Object.keys(about).some((locale) => !supported.includes(locale))) {
      fields.push({ path: 'about', code: 'locale' });
    }
    for (const locale of supported) {
      if (!Object.hasOwn(about, locale)) continue;
      const parsed = parseAboutText(about[locale]);
      if (!parsed.ok) {
        fields.push({ path: `about.${locale}`, code: parsed.error.rule });
        continue;
      }
      if (parsed.value !== '') texts.set(locale, parsed.value);
    }
    return fields.length > 0 ? err({ code: 'validation.failed', fields }) : ok(texts);
  }

  /** The locales whose text asserts a certification: `about.<locale>` with `claim-term`. */
  private async claimFields(
    context: CallContext,
    texts: ReadonlyMap<string, string>,
  ): Promise<Result<{ path: string; code: string }[], StoreProfileWriteFailure>> {
    const entries = [...texts].map(([locale, text]) => ({ locale, text }));
    if (entries.length === 0) return ok([]);
    const flags = await this.deps.claimCheck.flagged(context, entries);
    if (!flags.ok) return err({ code: 'sellers.unavailable' });
    return ok(
      entries.flatMap((entry, index) =>
        flags.value[index] === true ? [{ path: `about.${entry.locale}`, code: 'claim-term' }] : [],
      ),
    );
  }
}
