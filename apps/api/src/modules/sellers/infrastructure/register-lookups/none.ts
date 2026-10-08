import type {
  BusinessRegisterLookup,
  RegisterAnswer,
} from '../../application/ports/business-register-lookup';

export const NONE_REGISTER_ADAPTER = 'none';

/**
 * The `none` adapter (sellers design 4.2, 7.7; AC 34): the default of a Market that configures no
 * register. It reaches nothing: the callers see `performsLookups: false` and reserve no quota,
 * make no call and write no result, so the file stays "not performed" and the reviewer takes the
 * manual route. `lookup` is never reached; if it is, the honest answer is `unavailable`.
 */
export class NoneRegisterLookup implements BusinessRegisterLookup {
  readonly code = NONE_REGISTER_ADAPTER;
  readonly performsLookups = false;

  lookup(): Promise<RegisterAnswer> {
    return Promise.resolve({ outcome: 'unavailable' });
  }
}
