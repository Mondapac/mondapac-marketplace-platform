import type { CallContext } from '@mondapac/shared-kernel';

export type SlideTargetType = 'category' | 'product' | 'seller';

export interface SlideTarget {
  readonly type: SlideTargetType;
  readonly id: string;
}

export const targetKey = (target: SlideTarget): string => `${target.type}:${target.id}`;

/**
 * Whether the things a slide points at exist in the request's Market and may be shown to buyers:
 * a category in the public tree, a published product, a seller who may sell (not suspended). It is
 * the public facades of catalog and sellers, called with the caller's context; this module reads
 * no other module's tables.
 */
export interface SlideTargets {
  /**
   * The keys ({@link targetKey}) of the targets that are live in `context.market`; a target of
   * another Market is absent. `null` when the answer could not be had: the caller refuses.
   */
  live(context: CallContext, targets: readonly SlideTarget[]): Promise<ReadonlySet<string> | null>;
}

export const SLIDE_TARGETS = Symbol('STOREFRONT_SLIDE_TARGETS');
