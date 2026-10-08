import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import type { Sealed, SealedField } from './sealed';
import { identifierIndexKeyOf, type DraftIdentifier } from './business-identifier';
import { SellerFile, type DraftRequirements, type GeneralDraftInput } from './seller-file';
import type { ShopSlug } from './shop-slug';
import { parseStoreName } from './store-name';
import type { RegionZones } from './zone';

// The draft of SellerFile (sellers design 2.1, 3.1, 6.2; spike 3 record): saves recompute
// completeness, raise the version and refuse a file with an approved revision. Run for the two
// Market fixtures' shapes (AU and ZZ); the domain itself names no Market.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const T1 = T0.add({ minutes: 5 });
const SELLER = '01928a3c-0000-7000-8000-000000000001' as Id<'Seller'>;

const sealed = <F extends SealedField>(field: F, n = 1) => `v1.${field}-${n}` as Sealed<F>;
const slugOf = (raw: string) => raw as ShopSlug;
const storeName = (raw: string) => {
  const parsed = parseStoreName(raw);
  if (!parsed.ok) throw new Error('fixture store name refused');
  return parsed.value;
};

const FIXTURES = [
  {
    marketId: 'AU' as MarketId,
    zones: {
      default: 'Australia/Brisbane',
      selectable: ['Australia/Brisbane', 'Australia/Lindeman'],
    },
    area: 'greater-brisbane',
    // The Market fixtures differ here: one requires an identifier, the other does not (design 4.1).
    requirements: { identifierRequired: true, identifierScheme: 'abn' },
  },
  {
    marketId: 'ZZ' as MarketId,
    zones: { default: 'Pacific/Auckland', selectable: ['Pacific/Auckland', 'Pacific/Chatham'] },
    area: 'zz-central',
    requirements: { identifierRequired: false, identifierScheme: 'zz-corp-no' },
  },
] as const satisfies readonly {
  marketId: MarketId;
  zones: RegionZones;
  area: string;
  requirements: DraftRequirements;
}[];

const identifierOf = (scheme: string, n = 1): DraftIdentifier => ({
  scheme,
  sealed: `v1.identifier-${n}` as Sealed<'identifier'>,
  index: identifierIndexKeyOf(new Uint8Array(32).fill(n)),
});

const general = (overrides: Partial<GeneralDraftInput> = {}): GeneralDraftInput => ({
  storeName: storeName('Al Noor'),
  businessName: sealed('business-name'),
  phone: sealed('phone'),
  contactEmail: null,
  ...overrides,
});

describe.each(FIXTURES)(
  'SellerFile draft in $marketId',
  ({ marketId, zones, area, requirements }) => {
    /** The missing parts as this Market sees them: the identifier only where it is required. */
    const parts = (...list: string[]) =>
      list.flatMap((part) =>
        part === 'identifier' && !requirements.identifierRequired ? [] : [part],
      );
    const newFile = () =>
      SellerFile.create({
        sellerId: SELLER,
        marketId,
        origin: 'self',
        approvalRequiredAtRegistration: true,
        now: T0,
      });
    const address = (file: SellerFile, chosen?: unknown) =>
      file.saveAddress(
        {
          address: sealed('address'),
          registeredAddress: null,
          serviceAreaCode: area,
          zones,
          zone: { chosen, hint: undefined },
        },
        T1,
        requirements,
      );

    it('starts empty and incomplete, with every mandatory part missing', () => {
      const file = newFile();
      expect(file.state.draftComplete).toBe(false);
      expect(file.missing(requirements)).toEqual(
        parts('storeName', 'businessName', 'phone', 'address', 'timezone', 'identifier', 'slug'),
      );
      expect(file.state.draft.zone).toBeNull();
    });

    it('saves the general group, raises the version, stamps the change and stays incomplete', () => {
      const file = newFile();
      expect(file.saveGeneral(general(), T1, requirements)).toEqual({ ok: true, value: undefined });
      expect(file.state.version).toBe(2);
      expect(file.persistedVersion).toBe(1);
      expect(file.state.lastChangedAt).toEqual(T1);
      expect(file.state.draft.storeName?.key).toBe('al noor');
      expect(file.state.draftComplete).toBe(false);
      expect(file.missing(requirements)).toEqual(
        parts('address', 'timezone', 'identifier', 'slug'),
      );
    });

    it('becomes complete once the address and its zone are saved, in either order', () => {
      const first = newFile();
      first.saveGeneral(general(), T1, requirements);
      expect(address(first).ok).toBe(true);
      expect(first.state.draftComplete).toBe(false);
      expect(first.missing(requirements)).toEqual(parts('identifier', 'slug'));
      first.saveIdentifier(identifierOf(requirements.identifierScheme), T1, requirements);
      first.saveSlug(slugOf('al-noor'), T1, requirements);
      expect(first.state.draftComplete).toBe(true);
      expect(first.missing(requirements)).toEqual([]);
      expect(first.state.version).toBe(5);

      const second = newFile();
      address(second);
      second.saveIdentifier(identifierOf(requirements.identifierScheme), T1, requirements);
      second.saveSlug(slugOf('al-noor'), T1, requirements);
      expect(second.state.draftComplete).toBe(false);
      second.saveGeneral(general(), T1, requirements);
      expect(second.state.draftComplete).toBe(true);
    });

    it('allows a partial general save but never one without a phone (SEL-11, AC 7)', () => {
      const file = newFile();
      expect(file.saveGeneral(general({ phone: null }), T1, requirements)).toEqual({
        ok: false,
        error: { code: 'phone.required' },
      });
      expect(file.state.version).toBe(1);
      expect(
        file.saveGeneral(general({ storeName: null, businessName: null }), T1, requirements).ok,
      ).toBe(true);
      expect(file.missing(requirements)).toEqual(
        parts('storeName', 'businessName', 'address', 'timezone', 'identifier', 'slug'),
      );
      // A later save cannot clear the phone either.
      expect(file.saveGeneral(general({ phone: null }), T1, requirements).ok).toBe(false);
    });

    it('clears an optional field that a save leaves out, and keeps the other group', () => {
      const file = newFile();
      file.saveGeneral(general({ contactEmail: sealed('contact-email') }), T1, requirements);
      address(file);
      file.saveGeneral(general({ contactEmail: null }), T1, requirements);
      expect(file.state.draft.contactEmail).toBeNull();
      expect(file.state.draft.address).toBe(sealed('address'));
    });

    it('refuses every draft save on a file with an approved revision, and changes nothing', () => {
      // Slice 5 supplies the flag from `approved_revision_id`; the rule is the aggregate's now.
      const file = SellerFile.restore({ ...newFile().state, hasApprovedRevision: true });
      expect(file.draftEditable).toBe(false);
      expect(file.saveGeneral(general(), T1, requirements)).toEqual({
        ok: false,
        error: { code: 'file.change-request-required' },
      });
      expect(address(file)).toEqual({ ok: false, error: { code: 'file.change-request-required' } });
      expect(file.saveSlug(slugOf('al-noor'), T1, requirements)).toEqual({
        ok: false,
        error: { code: 'file.change-request-required' },
      });
      expect(file.state.draft.slug).toBeNull();
      expect(file.state.version).toBe(1);
      expect(file.state.lastChangedAt).toEqual(T0);
    });

    it('keeps a file without an approved revision editable: a new file has none', () => {
      const file = newFile();
      expect(file.state.hasApprovedRevision).toBe(false);
      expect(file.draftEditable).toBe(true);
      expect(file.saveGeneral(general(), T1, requirements).ok).toBe(true);
    });

    it('records the area, the region default and a chosen zone; refuses a zone off the list', () => {
      const file = newFile();
      expect(address(file)).toEqual({ ok: true, value: undefined });
      expect(file.state.draft.serviceAreaCode).toBe(area);
      expect(file.state.draft.zone).toEqual({
        operatingTimezone: zones.default,
        timezoneSource: 'default',
        addressTimezone: zones.default,
      });
      const other = zones.selectable[1];
      expect(address(file, other).ok).toBe(true);
      expect(file.state.draft.zone?.timezoneSource).toBe('seller');
      const version = file.state.version;
      expect(address(file, 'Etc/UTC')).toEqual({
        ok: false,
        error: { code: 'timezone.not-selectable' },
      });
      expect(file.state.version).toBe(version);
      expect(file.state.draft.zone?.operatingTimezone).toBe(other);
    });

    it('saves the slug: version +1, stamped, completeness recomputed (Q-M25)', () => {
      const file = newFile();
      expect(file.state.draft.slug).toBeNull();
      expect(file.saveSlug(slugOf('al-noor'), T1, requirements)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(file.state.draft.slug).toBe('al-noor');
      expect(file.state.version).toBe(2);
      expect(file.persistedVersion).toBe(1);
      expect(file.state.lastChangedAt).toEqual(T1);
      expect(file.missing(requirements)).not.toContain('slug');
      expect(file.state.draftComplete).toBe(false);
      // A different slug replaces it.
      file.saveSlug(slugOf('noor-shop'), T1, requirements);
      expect(file.state.draft.slug).toBe('noor-shop');
      expect(file.state.version).toBe(3);
    });

    it('treats the slug the draft already has as a no-op: no new version, no stamp', () => {
      const file = newFile();
      file.saveSlug(slugOf('al-noor'), T0.add({ minutes: 1 }), requirements);
      const before = file.state;
      expect(file.saveSlug(slugOf('al-noor'), T1, requirements)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(file.state).toBe(before);
    });

    it('keeps the slug through a general or an address save', () => {
      const file = newFile();
      file.saveSlug(slugOf('al-noor'), T1, requirements);
      file.saveGeneral(general(), T1, requirements);
      expect(file.state.draft.slug).toBe('al-noor');
      address(file);
      expect(file.state.draft.slug).toBe('al-noor');
    });

    describe('business identifier (slice 3)', () => {
      const scheme = requirements.identifierScheme;

      it('saves it with its scheme, sealed value and index; version +1, stamped', () => {
        const file = newFile();
        const identifier = identifierOf(scheme);
        expect(file.saveIdentifier(identifier, T1, requirements)).toEqual({
          ok: true,
          value: undefined,
        });
        expect(file.state.draft.identifier).toBe(identifier);
        expect(file.state.version).toBe(2);
        expect(file.persistedVersion).toBe(1);
        expect(file.state.lastChangedAt).toEqual(T1);
        expect(file.missing(requirements)).not.toContain('identifier');
      });

      it('is a part of completeness only where the Market requires it', () => {
        const file = newFile();
        file.saveGeneral(general(), T1, requirements);
        address(file);
        file.saveSlug(slugOf('al-noor'), T1, requirements);
        // Everything but the identifier.
        expect(file.state.draftComplete).toBe(!requirements.identifierRequired);
        expect(file.missing(requirements)).toEqual(parts('identifier'));
        file.saveIdentifier(identifierOf(scheme), T1, requirements);
        expect(file.state.draftComplete).toBe(true);
        // Clearing it makes the draft incomplete again only where it is required.
        file.saveIdentifier(null, T1, requirements);
        expect(file.state.draft.identifier).toBeNull();
        expect(file.state.draftComplete).toBe(!requirements.identifierRequired);
      });

      it('treats the same value of the same scheme as a no-op, whatever the ciphertext', () => {
        const file = newFile();
        file.saveIdentifier(identifierOf(scheme, 7), T1, requirements);
        const before = file.state;
        // A new seal of the same value has other ciphertext but the same index.
        const again = {
          ...identifierOf(scheme, 7),
          sealed: 'v1.other-seal' as Sealed<'identifier'>,
        };
        expect(file.saveIdentifier(again, T1.add({ minutes: 1 }), requirements).ok).toBe(true);
        expect(file.state).toBe(before);
        // Another value replaces it; clearing nothing is a no-op.
        file.saveIdentifier(identifierOf(scheme, 8), T1, requirements);
        expect(file.state.version).toBe(before.version + 1);
        const empty = newFile();
        expect(empty.saveIdentifier(null, T1, requirements).ok).toBe(true);
        expect(empty.state.version).toBe(1);
      });

      it('does not count an identifier of a scheme the Market no longer uses', () => {
        const file = newFile();
        file.saveIdentifier(identifierOf('retired-scheme'), T1, requirements);
        expect(file.missing(requirements)).toEqual(
          parts('storeName', 'businessName', 'phone', 'address', 'timezone', 'identifier', 'slug'),
        );
      });

      it('is refused on a file with an approved revision, and changes nothing', () => {
        const file = SellerFile.restore({ ...newFile().state, hasApprovedRevision: true });
        expect(file.saveIdentifier(identifierOf(scheme), T1, requirements)).toEqual({
          ok: false,
          error: { code: 'file.change-request-required' },
        });
        expect(file.state.draft.identifier).toBeNull();
        expect(file.state.version).toBe(1);
      });

      it('survives a general, address and slug save', () => {
        const file = newFile();
        const identifier = identifierOf(scheme);
        file.saveIdentifier(identifier, T1, requirements);
        file.saveGeneral(general(), T1, requirements);
        address(file);
        file.saveSlug(slugOf('al-noor'), T1, requirements);
        expect(file.state.draft.identifier).toBe(identifier);
      });
    });

    it('restores a stored file with the stored version as the expected version', () => {
      const file = newFile();
      file.saveGeneral(general(), T1, requirements);
      const restored = SellerFile.restore(file.state);
      expect(restored.persistedVersion).toBe(2);
      expect(restored.state).toEqual(file.state);
      expect(restored.pendingEvents).toEqual([]);
    });
  },
);
