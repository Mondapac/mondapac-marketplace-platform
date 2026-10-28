import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { derivedId } from '../../../../platform/hashing/derived-id';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_BLOG_ACCESS_EDIT } from '../../contracts/permissions';
import { BlogAccessChanged } from '../../domain/audit';
import { SellerBlogAccessChanged } from '../../domain/events';
import type { BlogAccessRepository } from '../ports/blog-access.repository';

/** The seller from the path and the body as it came: `{ enabled, unpublishLive? }`. */
export interface BlogAccessSetInput {
  readonly sellerId?: unknown;
  readonly body?: unknown;
}

export interface BlogAccessSetResult {
  readonly enabled: boolean;
  /** False when the switch already held the value (and nothing else was asked): nothing written. */
  readonly changed: boolean;
}

export type BlogAccessSetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    };

export interface BlogAccessSetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly blogAccess: BlogAccessRepository;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

const BODY_KEYS = ['enabled', 'unpublishLive'] as const;

/**
 * `sellers.blog-access-set` (blog package 1; owner decision Q1): a Platform Administrator turns a
 * seller's blog access on or off. Rule `permissions [sellers.blog-access.edit]` (protected, platform
 * scope). One read-write unit: the settings row is locked, the switch is set with who and when,
 * an audit row `sellers.blog-access.change` is written and the event
 * `sellers.blog-access-changed.v1` goes to the outbox. Turning it off may ask, with
 * `unpublishLive: true`, for the seller's live posts to come off the site; the blog consumes the
 * event and does that in its own unit. Turning it off never deletes a post. A repeat of the value
 * already held is `changed: false` and writes nothing, unless `unpublishLive` is asked.
 */
export class BlogAccessSetUseCase extends UseCase<
  BlogAccessSetInput,
  BlogAccessSetResult,
  BlogAccessSetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.blog-access-set',
    rule: { kind: 'permissions', allOf: [SELLERS_BLOG_ACCESS_EDIT.key] },
  };

  readonly #logger = new Logger('BlogAccessSet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogAccessSetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BlogAccessSetInput,
  ): Promise<Result<BlogAccessSetResult, BlogAccessSetFailure>> {
    const result = await this.set(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.blog-access-set',
      code: result.ok ? (result.value.changed ? 'changed' : 'unchanged') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async set(
    context: CallContext,
    input: BlogAccessSetInput,
  ): Promise<Result<BlogAccessSetResult, BlogAccessSetFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;

    const body = input.body;
    const fields: { path: string; code: string }[] = [];
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return err({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
    }
    for (const key of Object.keys(body).sort()) {
      if (!(BODY_KEYS as readonly string[]).includes(key)) {
        fields.push({ path: key.slice(0, 64), code: 'unknown-field' });
      }
    }
    const { enabled, unpublishLive } = body as Record<string, unknown>;
    if (typeof enabled !== 'boolean') {
      fields.push({ path: 'enabled', code: enabled === undefined ? 'required' : 'type' });
    }
    if (unpublishLive !== undefined && typeof unpublishLive !== 'boolean') {
      fields.push({ path: 'unpublishLive', code: 'type' });
    }
    if (enabled === true && unpublishLive === true) {
      fields.push({ path: 'unpublishLive', code: 'only-when-switching-off' });
    }
    if (fields.length > 0 || typeof enabled !== 'boolean') {
      return err({ code: 'validation.failed', fields });
    }
    const unpublish = unpublishLive === true;

    const { unitOfWork, blogAccess, audit, outbox, clock } = this.deps;
    return unitOfWork.run<BlogAccessSetResult, BlogAccessSetFailure>(market, async () => {
      const state = await blogAccess.lock(market, sellerId);
      if (state === null) return err({ code: 'file.not-found' });
      if (state.enabled === enabled && !unpublish) return ok({ enabled, changed: false });
      const now = clock.now();
      await blogAccess.set(market, sellerId, { enabled, by: actor.accountId, at: now });
      await audit.record(
        context,
        BlogAccessChanged.entry(sellerId, {
          before: { enabled: state.enabled },
          after: { enabled, unpublishLive: unpublish },
        }),
      );
      await outbox.append(context, [
        SellerBlogAccessChanged.record({
          aggregateId: derivedId<'SellerBlogAccess'>('seller-blog-access', sellerId),
          aggregateVersion: state.version,
          occurredAt: now,
          payload: { sellerId, enabled, unpublishLive: unpublish },
        }),
      ]);
      return ok({ enabled, changed: state.enabled !== enabled });
    });
  }
}
