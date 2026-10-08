import type {
  RegisterLookupPolicy,
  RegisterLookupSettings,
} from '../application/ports/register-lookup-policy';

/**
 * The register-lookup values until Market configuration can carry them (sellers design 4.1,
 * `sellers.registerLookup.*`; the schema of `platform/market-config` does not have the keys yet,
 * a shared-file change): every Market has no register, which is the design's default `none`
 * (AC 34). When the keys land, this class is replaced by a reader of
 * `markets.get(id).sellers.registerLookup` that validates the adapter name at start-up.
 */
export class NoRegisterLookupPolicy implements RegisterLookupPolicy {
  settingsOf(): RegisterLookupSettings {
    return { kind: 'none' };
  }
}
