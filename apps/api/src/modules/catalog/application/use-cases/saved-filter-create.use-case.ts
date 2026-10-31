import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SavedFilterSharedAudit } from '../../domain/audit';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  type SavedFilter,
} from '../../domain/saved-filter';
import type { SavedFilterRepository } from '../ports/saved-filter.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import {
  adminOf,
  auditListOf,
  canShareOf,
  listOf,
  nameOf,
  viewOf,
  visibilityOf,
  type SavedFilterView,
} from '../saved-filters/saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

export interface SavedFilterCreateInput {
  readonly listKey?: unknown;
  readonly name?: unknown;
  readonly visibility?: unknown;
  readonly payload?: unknown;
}

export type SavedFilterCreateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'saved-filter.name-taken' }
  | { readonly code: 'saved-filter.limit-reached'; readonly max: number }
  | { readonly code: 'saved-filter.shared-limit-reached'; readonly max: number }
  | ValidationFailure;

export interface SavedFilterCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly savedFilters: SavedFilterRepository;
  readonly shareCheck: AccessProbe;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const KEYS = new Set(['listKey', 'name', 'visibility', 'payload']);

/**
 * `saved-filter.create` (catalog design 9.2d): saves the tab, search, filters and sort of an
 * admin list under a name, for the caller only (`me`) or for every admin who can see the list
 * (`everyone`). Rule: the key `catalog.product.view` and the admin population; `everyone` also
 * needs `catalog.saved-filter.share`, else `access.denied` and nothing is written. The payload is
 * read by the list's own vocabulary and stored in its canonical form (a closed document: no
 * unknown key). One admin keeps at most {@link MAX_SAVED_FILTERS_PER_OWNER} filters in a list and
 * a list has at most {@link MAX_SHARED_SAVED_FILTERS} shared with everyone; a name is one per
 * owner and, among shared filters, one per list, whatever its case. A filter shared with everyone
 * is audited (ids and codes only, never the name). Serializable, so two saves racing at the cap
 * cannot both pass.
 */
export class SavedFilterCreate extends UseCase<
  SavedFilterCreateInput,
  SavedFilterView,
  SavedFilterCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.saved-filter-create',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  readonly #logger = new Logger('SavedFilterCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SavedFilterCreateInput,
  ): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.saved-filter-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: SavedFilterCreateInput,
  ): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    for (const key of Object.keys(input)) if (!KEYS.has(key)) return invalid(key, 'unknown');
    const list = listOf(input.listKey);
    if (!list.ok) return list;
    const name = nameOf(input.name);
    if (!name.ok) return name;
    const visibility = visibilityOf(input.visibility);
    if (!visibility.ok) return visibility;
    const payload = list.value.parsePayload(input.payload);
    if (!payload.ok) return payload;

    const canShare = await canShareOf(this.deps.shareCheck, context);
    if (!canShare.ok) return canShare;
    if (visibility.value === 'everyone' && !canShare.value) return err({ code: 'access.denied' });

    const { market } = context;
    const { deps } = this;
    const listKey = list.value.key;
    const written = await deps.unitOfWork.run<SavedFilter, SavedFilterCreateFailure>(
      market,
      async () => {
        if (
          (await deps.savedFilters.countOwnedBy(market, listKey, admin.accountId)) >=
          MAX_SAVED_FILTERS_PER_OWNER
        ) {
          return err({ code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER });
        }
        if (
          visibility.value === 'everyone' &&
          (await deps.savedFilters.countShared(market, listKey)) >= MAX_SHARED_SAVED_FILTERS
        ) {
          return err({ code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS });
        }
        const now = deps.clock.now();
        const filter: SavedFilter = {
          id: deps.ids.next<'SavedFilter'>(),
          listKey,
          ownerAccountId: admin.accountId,
          visibility: visibility.value,
          name: name.value,
          payload: payload.value,
          position: await deps.savedFilters.nextPosition(market, listKey, admin.accountId),
          createdAt: now,
          updatedAt: now,
        };
        if ((await deps.savedFilters.add(market, filter)) === 'name-taken') {
          return err({ code: 'saved-filter.name-taken' });
        }
        if (filter.visibility === 'everyone') {
          await deps.audit.record(
            context,
            SavedFilterSharedAudit.entry(filter.id, {
              after: { listKey: auditListOf(filter.listKey), visibility: 'everyone' },
            }),
          );
        }
        return ok(filter);
      },
      { isolation: 'serializable' },
    );
    if (!written.ok) return written;
    return ok(viewOf(written.value, admin.accountId, canShare.value, null));
  }
}
