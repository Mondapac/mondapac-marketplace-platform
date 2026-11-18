import type { CallContext } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import { canDiscard, planReorder } from '../domain/category-edit';
import { attributeIdOf, editorAccountOf as attributeEditorOf } from './attributes/attribute-editor';
import {
  categoryIdOf,
  editorAccountOf as categoryEditorOf,
  lockTreeInUnit,
} from './categories/category-editor';
import { clearRestructure, restructureInUnit } from './categories/category-restructure';
import { discardInUnit, hideInUnit, reorderInUnit } from './categories/category-write-core';
import {
  ClearedByRequest,
  deciderOf,
  mayRun,
  treeSnapshot,
  type CatalogueStructureDependencies,
} from './catalogue-appliers';
import { parentOf, reorderOf } from './catalogue-actions';
import { AttributeDefinitionCreate } from './use-cases/attribute-definition-create.use-case';
import { discardAttributeInUnit } from './use-cases/attribute-definition-discard.use-case';
import { CategoryCreate } from './use-cases/category-create.use-case';
import { CategoryMove, moveSpec } from './use-cases/category-move.use-case';
import { CategoryReorder } from './use-cases/category-reorder.use-case';

// The reverters of the creates and moves of area catalogue (Admin Inbox › System requests, owner
// decision of 18 Nov 2026): they go live at once, and a rejected or withdrawn one is undone in the
// decision's open unit through the same in-unit functions the routes use, naming the request in
// the audit row:
// - a new category is discarded while it never went live (hidden, never shown, no child, no
//   product revision), else hidden (with its live descendants); one already hidden stays so;
// - a moved category is moved back under its parent before, only while it is still under the new
//   one (last among the old siblings: its old place is not kept), with the same plan and
//   certification check as a move (`check`, before the unit);
// - a reorder is swapped back while both categories still hold the places it gave them;
// - a new attribute definition is discarded while it is still a draft; once published the revert
//   is `not-permitted` (the request can only be approved: archiving is a separate action).

/** The reason the revision of a move undone by a reviewer carries. */
const MOVE_UNDONE_REASON = 'Move undone in Admin Inbox > System requests';

/** `catalog.category-create`: a new platform category. */
export class CategoryCreateReverter implements SystemChangeReverter {
  constructor(private readonly deps: CatalogueStructureDependencies) {}

  /** Before the unit: the decider holds the key the create needs (it also discards and hides). */
  async check(context: CallContext): Promise<'ok' | 'not-permitted'> {
    if (categoryEditorOf(context) === null) return 'not-permitted';
    return (await mayRun(this.deps, context, CategoryCreate.access)) ? 'ok' : 'not-permitted';
  }

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const accountId = deciderOf(context);
    const id = categoryIdOf(request.subjectRef);
    if (!id.ok || request.after['exists'] !== true) return 'gone';
    const { market } = context;
    try {
      const locked = await lockTreeInUnit(this.deps, market);
      if (locked === null) throw new Error('catalog: the category tree is too large');
      const target = locked.nodes.find((node) => node.id === id.value);
      if (target === undefined) return 'gone';
      if (target.status !== 'active' && target.status !== 'hidden') return 'changed-since';
      const facts = await this.deps.store.discardFacts(market, target.id);
      if (canDiscard(locked.nodes, target, facts)) {
        const done = await discardInUnit(
          this.deps,
          context,
          accountId,
          locked.nodes,
          target.id,
          locked.treeVersion,
          request.requestId,
        );
        return done.ok ? 'reverted' : 'changed-since';
      }
      // Went live once, or has children or products now: it is hidden, not discarded.
      if (target.status === 'hidden') return 'reverted';
      const hidden = await hideInUnit(
        this.deps,
        context,
        accountId,
        locked.nodes,
        target.id,
        locked.treeVersion,
        request.requestId,
      );
      return hidden.ok ? 'reverted' : 'changed-since';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
  }
}

/** `catalog.category-move`: a category moved under another parent. */
export class CategoryMoveReverter implements SystemChangeReverter {
  readonly #cleared = new ClearedByRequest<ReadonlySet<string>>();

  constructor(private readonly deps: CatalogueStructureDependencies) {}

  #spec(context: CallContext, request: RevertRequest, parentId: ReturnType<typeof parentOf>) {
    const id = categoryIdOf(request.subjectRef);
    if (!id.ok || parentId === undefined) return null;
    return moveSpec(this.deps, context, {
      accountId: deciderOf(context),
      targetId: id.value,
      parentId,
      treeVersion: 0,
      reason: MOVE_UNDONE_REASON,
      maxDepth: this.deps.policy.maxCategoryDepth(context.market),
      requestId: request.requestId,
      opened: () => Promise.resolve(ok(null)),
    });
  }

  /**
   * Before the unit: the decider holds the restructure key, and the move back passes the plan and
   * certification's check of the categories it would take off the products' paths (fail closed).
   */
  async check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    if (categoryEditorOf(context) === null) return 'not-permitted';
    if (!(await mayRun(this.deps, context, CategoryMove.access))) return 'not-permitted';
    const id = categoryIdOf(request.subjectRef);
    const back = parentOf(request.before);
    const now = parentOf(request.after);
    if (!id.ok || back === undefined || now === undefined) return 'ok'; // `gone`
    try {
      const nodes = await treeSnapshot(this.deps, context);
      if (nodes === null) return 'not-permitted';
      const seen = nodes.find((node) => node.id === id.value);
      // Gone, or moved again since: the revert answers that.
      if (seen === undefined || seen.parentId !== now) return 'ok';
      const spec = this.#spec(context, request, back);
      if (spec === null) return 'ok';
      const cleared = await clearRestructure(this.deps, context, spec);
      if (!cleared.ok) return 'not-permitted';
      this.#cleared.put(request.requestId, cleared.value);
      return 'ok';
    } catch {
      return 'not-permitted';
    }
  }

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    deciderOf(context);
    const id = categoryIdOf(request.subjectRef);
    const back = parentOf(request.before);
    const now = parentOf(request.after);
    const cleared = this.#cleared.take(request.requestId);
    if (!id.ok || back === undefined || now === undefined) return 'gone';
    try {
      const locked = await lockTreeInUnit(this.deps, context.market);
      if (locked === null) throw new Error('catalog: the category tree is too large');
      const target = locked.nodes.find((node) => node.id === id.value);
      if (target === undefined) return 'gone';
      if (target.parentId !== now) return 'changed-since';
      if (cleared === undefined) return 'not-permitted';
      const spec = this.#spec(context, request, back);
      if (spec === null) return 'gone';
      const moved = await restructureInUnit(
        this.deps,
        context,
        spec,
        locked.nodes,
        locked.treeVersion,
        cleared,
      );
      // A plan the tree refuses now (a sibling took the name, the depth, a new certificate rule)
      // is a change since the move: nothing was written.
      return moved.ok ? 'reverted' : 'changed-since';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
  }
}

/** `catalog.category-reorder`: a category moved up or down among its siblings. */
export class CategoryReorderReverter implements SystemChangeReverter {
  constructor(private readonly deps: CatalogueStructureDependencies) {}

  async check(context: CallContext): Promise<'ok' | 'not-permitted'> {
    if (categoryEditorOf(context) === null) return 'not-permitted';
    return (await mayRun(this.deps, context, CategoryReorder.access)) ? 'ok' : 'not-permitted';
  }

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const accountId = deciderOf(context);
    const id = categoryIdOf(request.subjectRef);
    const before = reorderOf(request.before);
    const after = reorderOf(request.after);
    if (!id.ok || before === null || after === null) return 'gone';
    try {
      const locked = await lockTreeInUnit(this.deps, context.market);
      if (locked === null) throw new Error('catalog: the category tree is too large');
      const target = locked.nodes.find((node) => node.id === id.value);
      const neighbour = locked.nodes.find((node) => node.id === after.neighbourId);
      if (target === undefined || neighbour === undefined) return 'gone';
      if (
        target.position !== after.position ||
        neighbour.position !== after.neighbourPosition ||
        target.parentId !== neighbour.parentId
      ) {
        return 'changed-since';
      }
      // The reorder moved it up when its place got smaller: back is down, and the other way.
      const direction = after.position < before.position ? 'down' : 'up';
      const next = planReorder(locked.nodes, target, direction);
      if (!next.ok || next.value.id !== neighbour.id) return 'changed-since';
      const done = await reorderInUnit(
        this.deps,
        context,
        accountId,
        locked.nodes,
        target.id,
        direction,
        locked.treeVersion,
        request.requestId,
      );
      return done.ok ? 'reverted' : 'changed-since';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
  }
}

/** `catalog.attribute-create`: a new attribute definition (a draft). */
export class AttributeCreateReverter implements SystemChangeReverter {
  constructor(private readonly deps: CatalogueStructureDependencies) {}

  async check(context: CallContext): Promise<'ok' | 'not-permitted'> {
    if (attributeEditorOf(context) === null) return 'not-permitted';
    return (await mayRun(this.deps, context, AttributeDefinitionCreate.access))
      ? 'ok'
      : 'not-permitted';
  }

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    deciderOf(context);
    const id = attributeIdOf(request.subjectRef);
    if (id === null || request.after['exists'] !== true) return 'gone';
    try {
      const found = await this.deps.attributeStore.findById(context.market, id);
      if (found === null) return 'gone';
      if (found.state.code !== request.after['code']) return 'gone';
      // Published since: a reviewer cannot take it back here (archiving is its own action).
      if (found.state.status === 'active') return 'not-permitted';
      if (found.state.status !== 'draft') return 'changed-since';
      const done = await discardAttributeInUnit(this.deps, context, found, request.requestId);
      return done.ok ? 'reverted' : 'changed-since';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
  }
}
