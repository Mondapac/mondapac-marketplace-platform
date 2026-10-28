import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { BlogDependencies } from './blog-dependencies';

/** The input a flow function takes (its third parameter). */
export type FlowInput<F> = F extends (
  deps: BlogDependencies,
  context: CallContext,
  input: infer I,
  ...rest: never[]
) => unknown
  ? I
  : never;

/** The value a flow function answers on success. */
export type FlowValue<F> = F extends (...args: never[]) => Promise<Result<infer T, unknown>>
  ? T
  : never;
