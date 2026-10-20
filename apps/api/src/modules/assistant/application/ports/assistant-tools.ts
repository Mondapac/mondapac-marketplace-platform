import type { CallContext } from '@mondapac/shared-kernel';
import type { AssistantCard, AssistantNotice } from '../../domain/cards';
import type { ToolRequest } from '../../domain/tools';

/** A tool run: what the model reads (data, never instructions) and what the buyer is shown. */
export interface ToolOutcome {
  /** JSON the server built; it never holds a price, stock figure or certification. */
  readonly forModel: string;
  readonly isError: boolean;
  readonly cards: readonly AssistantCard[];
  readonly notices: readonly AssistantNotice[];
}

/**
 * The READ tools of plan section 3 that exist on main, each through the owning module's facade
 * with the buyer's `CallContext` unchanged (ADR-0019 R3): the assistant sees only what the
 * buyer's own storefront read would show.
 */
export interface AssistantTools {
  run(context: CallContext, request: ToolRequest): Promise<ToolOutcome>;
}

export const ASSISTANT_TOOLS = Symbol('ASSISTANT_TOOLS');
