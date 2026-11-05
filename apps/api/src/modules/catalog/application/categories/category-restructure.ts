import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { MAX_UNIT_TIMEOUT_MS } from '../../../../platform/unit-of-work/unit-of-work';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import type { EditableCategory } from '../../domain/category-edit';
import {
  RESTRUCTURE_REASON_MAX,
  RESTRUCTURE_REASON_MIN,
  type RestructureChange,
  type RestructurePlan,
  type RestructureRefusal,
} from '../../domain/category-restructure';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryEditStore, CategoryRestructureStore } from '../ports/category-edit.store';
import type {
  CategoryRetirementCheck,
  CategoryRetirementRefusal,
} from '../ports/category-retirement-check';
import type { OfferRepository } from '../ports/offer.repository';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import type { TagReevaluationRequestRepository } from '../ports/tag-reevaluation-requests';
import { markProductForReevaluation } from '../tags/publish-fan-out';
import {
  announceChanged,
  invalid,
  runStructural,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from './category-editor';
import type { ValidationFailure } from './category-admin-views';

/**
 * The shared run of a move, merge or archive (categories package C4a; catalog design 4.6; review
 * amendments 4 Nov 2026, C4 and C3 done). In order:
 *
 * 1. Plan on a read-only snapshot of the tree; a refusal answers before anything is asked.
 * 2. `certification.assertCategoriesRetirable` on the plan's ids, with no unit open (C-4): a
 *    refusal is `category.referenced-by-policy` with the type codes; an error refuses too (fail
 *    closed, `category.check-unavailable`).
 * 3. One structural unit (the tree version guarded first, so lock order is tree, then rows): plan
 *    again on the locked tree; a plan that now names an id the check did not clear is
 *    `conflict.stale`. Above the Market's `maxCategoryChangeTags` tags it is
 *    `category.impact-too-large`. Then every change gets a revision (the reason note on the acted-on
 *    category's), every changed category its `platform-category-changed` event, every published
 *    product under the affected categories has its Offers' `active` tags marked `rechecking` with
 *    the entry path `category-change` and a `revision-published` request, so the fan-out job asks
 *    `evaluateClaims` again against the new tree (M1). The caller adds the audit row and its event.
 */

export type CategoryRestructureFailure =
  | CategoryWriteFailure
  | RestructureRefusal
  | CategoryRetirementRefusal
  | { readonly code: 'category.impact-too-large'; readonly max: number };

export interface CategoryRestructureDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: CategoryEditStore;
  readonly restructure: CategoryRestructureStore;
  readonly categories: PlatformCategoryRepository;
  readonly policy: CatalogMarketPolicy;
  readonly retirement: CategoryRetirementCheck;
  readonly offers: OfferRepository;
  readonly requests: TagReevaluationRequestRepository;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The products one change may mark at most, read in one query; more is `impact-too-large`. */
export const RESTRUCTURE_MAX_PRODUCTS = 50_000;

const CONTROL = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/** The reason note (plan section 13): 10 to 500 characters, trimmed, no control or bidi mark. */
export function reasonOf(raw: unknown): Result<string, ValidationFailure> {
  if (raw === undefined || raw === null) return invalid('reason', 'required');
  if (typeof raw !== 'string') return invalid('reason', 'type');
  const length = [...raw].length;
  if (raw !== raw.trim() || CONTROL.test(raw)) return invalid('reason', 'format');
  if (length < RESTRUCTURE_REASON_MIN || length > RESTRUCTURE_REASON_MAX) {
    return invalid('reason', 'length');
  }
  return ok(raw);
}

/** What the use case adds in the unit after the shared writes: its audit row and its event. */
export interface RestructureFinish {
  readonly target: EditableCategory;
  readonly plan: RestructurePlan;
  readonly tagsMarked: number;
  readonly targetVersion: number;
}

export interface RestructureSpec {
  readonly accountId: Id<'Account'>;
  readonly targetId: Id<'Category'>;
  readonly treeVersion: number;
  readonly reason: string;
  /** The plan, from the nodes and the direct product counts of their ids. */
  readonly plan: (
    nodes: readonly EditableCategory[],
    target: EditableCategory,
    read: { readonly directProducts: ReadonlyMap<string, number>; readonly onlyHere: number },
  ) => Result<RestructurePlan, RestructureRefusal>;
  /** Extra writes in the unit (business activities), then the audit row and the event. */
  readonly finish: (finish: RestructureFinish) => Promise<void>;
}

async function readFacts(
  deps: CategoryRestructureDependencies,
  market: MarketContext,
  nodes: readonly EditableCategory[],
  target: EditableCategory,
): Promise<{ readonly directProducts: ReadonlyMap<string, number>; readonly onlyHere: number }> {
  const ids = nodes.map((node) => node.id);
  const directProducts = await deps.restructure.directProducts(market, ids);
  const onlyHere = await deps.restructure.onlyCategoryProducts(market, target.id);
  return { directProducts, onlyHere };
}

export async function runRestructure(
  deps: CategoryRestructureDependencies,
  context: CallContext,
  spec: RestructureSpec,
): Promise<Result<{ readonly category: CategoryWriteView }, CategoryRestructureFailure>> {
  const { market } = context;

  // 1. Plan on a snapshot, before the certification check.
  type Snapshot = {
    readonly nodes: readonly EditableCategory[];
    readonly target: EditableCategory | null;
    readonly facts: Awaited<ReturnType<typeof readFacts>> | null;
  } | null;
  const snapshot = await deps.unitOfWork.run<Snapshot, never>(
    market,
    async () => {
      const nodes = await deps.store.loadAll(market, MAX_TREE_NODES + 1);
      if (nodes.length > MAX_TREE_NODES) return ok(null);
      const target = nodes.find((node) => node.id === spec.targetId);
      if (target === undefined) return ok({ nodes, target: null, facts: null });
      return ok({ nodes, target, facts: await readFacts(deps, market, nodes, target) });
    },
    { readOnly: true },
  );
  if (!snapshot.ok || snapshot.value === null) return err({ code: 'access.unavailable' });
  const { nodes, target, facts } = snapshot.value;
  if (target === null || facts === null) return err({ code: 'category.not-found' });
  const draft = spec.plan(nodes, target, facts);
  if (!draft.ok) return draft;

  // 2. The certification check, with no unit open (C-4; fail closed).
  const checked = new Set<string>(draft.value.retirementCheckIds);
  const cleared = await deps.retirement.assertRetirable(context, [...checked] as Id<'Category'>[]);
  if (!cleared.ok) return cleared;

  // 3. The unit.
  const maxTags = deps.policy.maxCategoryChangeTags(market);
  const at = deps.clock.now();
  const result = await runStructural<
    { readonly category: CategoryWriteView },
    CategoryRestructureFailure
  >(
    deps,
    market,
    spec.treeVersion,
    async (locked, nextTreeVersion) => {
      const current = locked.find((node) => node.id === spec.targetId);
      if (current === undefined) return err({ code: 'category.not-found' });
      const plan = spec.plan(locked, current, await readFacts(deps, market, locked, current));
      if (!plan.ok) return plan;
      if (plan.value.retirementCheckIds.some((id) => !checked.has(id))) {
        return err({ code: 'conflict.stale' });
      }
      const under = await deps.restructure.productsUnder(
        market,
        plan.value.affectedIds,
        RESTRUCTURE_MAX_PRODUCTS + 1,
      );
      if (under.activeTags > maxTags || under.products.length > RESTRUCTURE_MAX_PRODUCTS) {
        return err({ code: 'category.impact-too-large', max: maxTags });
      }

      let targetVersion = current.version;
      for (const change of plan.value.changes) {
        const node = locked.find((entry) => entry.id === change.id)!;
        const version = await deps.store.apply(market, {
          category: node,
          revisionId: deps.ids.next<'CategoryRevision'>(),
          kind: change.kind,
          texts: node.texts,
          patch: patchOf(change),
          authorAccountId: spec.accountId,
          now: at,
          ...(node.id === current.id ? { reason: spec.reason } : {}),
        });
        if (node.id === current.id) targetVersion = version;
        await announceChanged(deps, context, node.id, version);
      }

      let tagsMarked = 0;
      for (const product of under.products) {
        tagsMarked += await markProductForReevaluation(deps, market, {
          productId: product.productId,
          revisionId: product.revisionId,
          actor: { kind: 'admin', accountId: spec.accountId },
          now: at,
          entryPath: 'category-change',
        });
      }
      await spec.finish({ target: current, plan: plan.value, tagsMarked, targetVersion });
      const head = plan.value.changes[0]!;
      return ok({
        category: {
          id: current.id,
          slug: current.slug,
          status: head.status ?? current.status,
          version: targetVersion,
          revisionNo: current.revisionNo + 1,
          treeVersion: nextTreeVersion,
        },
      });
    },
    { timeoutMs: MAX_UNIT_TIMEOUT_MS },
  );
  return result;
}

function patchOf(change: RestructureChange) {
  return {
    ...(change.parentId === undefined ? {} : { parentId: change.parentId }),
    ...(change.position === undefined ? {} : { position: change.position }),
    ...(change.status === undefined ? {} : { status: change.status }),
    ...(change.hiddenById === undefined ? {} : { hiddenById: change.hiddenById }),
    ...(change.mergedIntoId === undefined ? {} : { mergedIntoId: change.mergedIntoId }),
  };
}
