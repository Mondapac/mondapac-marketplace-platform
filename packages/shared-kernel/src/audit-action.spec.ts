import {
  auditField,
  defineAuditAction,
  describeAuditAction,
  encodeAuditFields,
  isAuditActionDefinition,
  MAX_AUDIT_LIST_LENGTH,
} from './audit-action';
import type { AuditFields } from './audit-action';
import { eventField } from './domain-event';
import type { Id } from './id';
import { Temporal } from './time';

const ID = '01890a5d-ac96-774b-bcce-b302099a8057' as Id;
const OTHER_ID = '01890a5d-ac96-774b-bcce-b302099a8058' as Id;
const KNOWN_KEYS = { isKnownPermissionKey: (key: string) => key === 'identity.role.view' };

const roleAssigned = defineAuditAction({
  action: 'identity.account-role.assigned',
  targetType: 'identity.account',
  actors: ['system', 'authenticated', 'anonymous'],
  before: { roleId: auditField.optional(auditField.id()) },
  after: {
    roleId: auditField.id(),
    scope: auditField.enumOf(['platform', 'seller'] as const),
    founding: auditField.boolean(),
    boundSubjectId: auditField.id(),
  },
});

describe('defineAuditAction (platform-audit.md 3.2)', () => {
  it('derives the owner from the action and keeps the declaration, actors sorted', () => {
    expect(roleAssigned.owner).toBe('identity');
    expect(roleAssigned.targetType).toBe('identity.account');
    expect(roleAssigned.targetId).toEqual({ kind: 'id' });
    expect(roleAssigned.actors).toEqual(['anonymous', 'authenticated', 'system']);
    expect(Object.isFrozen(roleAssigned)).toBe(true);
    expect(isAuditActionDefinition(roleAssigned)).toBe(true);
  });

  it('takes platform.<component> as the owner of a platform action (Ali, Q4)', () => {
    const viewed = defineAuditAction({
      action: 'platform.audit-log.viewed',
      targetType: 'platform.audit-log.market',
      targetId: auditField.enumOf(['au', 'zz'] as const),
      actors: ['authenticated'],
    });
    const changed = defineAuditAction({
      action: 'platform.ai.market-settings.changed',
      targetType: 'platform.ai.market-settings',
      actors: ['authenticated'],
      after: { enabled: auditField.boolean() },
    });

    expect(viewed.owner).toBe('platform.audit-log');
    expect(changed.owner).toBe('platform.ai');
  });

  it('builds a frozen entry with null for an undeclared side', () => {
    const created = defineAuditAction({
      action: 'identity.role.created',
      targetType: 'identity.role',
      actors: ['authenticated'],
      after: { addedKeys: auditField.listOf(auditField.permissionKey(), 8) },
    });
    const entry = created.entry(ID, { after: { addedKeys: ['identity.role.view'] } });

    expect(entry).toEqual({
      action: 'identity.role.created',
      targetType: 'identity.role',
      targetId: ID,
      before: null,
      after: { addedKeys: ['identity.role.view'] },
    });
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('refuses an object literal shaped like a definition', () => {
    expect(isAuditActionDefinition({ ...roleAssigned })).toBe(false);
    expect(isAuditActionDefinition(null)).toBe(false);
  });

  describe('fails at boot on', () => {
    const base = {
      action: 'sellers.business-details.viewed',
      targetType: 'sellers.seller',
      actors: ['authenticated'] as const,
    };

    it.each([
      ['a two-segment action', { action: 'sellers.viewed' }],
      ['a four-segment module action', { action: 'sellers.a.b.viewed' }],
      ['an upper-case action', { action: 'Sellers.seller.viewed' }],
      ['an underscore', { action: 'sellers.business_details.viewed' }],
      ['a five-segment platform action', { action: 'platform.ai.a.b.changed' }],
      ['a two-segment platform action', { action: 'platform.ai' }],
      ['an action over 128 characters', { action: `sellers.${'a'.repeat(120)}.viewed` }],
      ['a target type of another module (a foreign prefix)', { targetType: 'identity.account' }],
      ['a target type with two tails', { targetType: 'sellers.seller.file' }],
      ['a bare target type', { targetType: 'sellers' }],
      [
        'a platform target type outside its component',
        { action: 'platform.ai.settings.changed', targetType: 'platform.settings' },
      ],
      ['no actor', { actors: [] }],
      ['a repeated actor', { actors: ['system', 'system'] }],
      ['an unknown actor', { actors: ['admin'] }],
      ['a target id of kind boolean', { targetId: auditField.boolean() }],
      ['an empty after', { after: {} }],
      ['a snake_case field', { after: { role_id: auditField.id() } }],
      ['a free-text field kind', { after: { reason: { kind: 'text' } } }],
      ['a listOf without a maximum', { after: { keys: eventField.listOf(auditField.id()) } }],
      ['a listOf with maximum 0', { after: { keys: auditField.listOf(auditField.id(), 0) } }],
      [
        'a listOf above the ceiling',
        { after: { keys: auditField.listOf(auditField.id(), MAX_AUDIT_LIST_LENGTH + 1) } },
      ],
      [
        'a listOf with a fractional maximum',
        { after: { keys: auditField.listOf(auditField.id(), 1.5) } },
      ],
      [
        'a nested listOf',
        {
          after: {
            keys: auditField.listOf(
              auditField.listOf(auditField.id(), 2) as unknown as ReturnType<typeof auditField.id>,
              2,
            ),
          },
        },
      ],
      [
        'an enumOf written as a literal with a text value',
        { before: { state: { kind: 'enumOf', values: ['Has Spaces'] } } },
      ],
      [
        'anonymous without boundSubjectId (W4a)',
        { actors: ['anonymous'], after: { sessionId: auditField.id() } },
      ],
      [
        'anonymous with boundSubjectId of another kind',
        { actors: ['anonymous'], after: { boundSubjectId: auditField.optional(auditField.id()) } },
      ],
      [
        'anonymous with boundSubjectId in before only',
        { actors: ['anonymous', 'system'], before: { boundSubjectId: auditField.id() } },
      ],
    ])('%s', (_case, overrides) => {
      expect(() =>
        defineAuditAction({ ...base, ...overrides } as unknown as Parameters<
          typeof defineAuditAction
        >[0]),
      ).toThrow(TypeError);
    });
  });
});

describe('encodeAuditFields (W4)', () => {
  const fields: AuditFields = {
    roleId: auditField.id(),
    state: auditField.enumOf(['active', 'suspended'] as const),
    founding: auditField.boolean(),
    count: auditField.integer(),
    at: auditField.instant(),
    key: auditField.permissionKey(),
    keys: auditField.listOf(auditField.permissionKey(), 2),
    ids: auditField.listOf(auditField.id(), 3),
    previous: auditField.optional(auditField.id()),
  };
  const valid = {
    roleId: ID,
    state: 'active',
    founding: true,
    count: 3,
    at: Temporal.Instant.from('2026-10-08T01:02:03.004Z'),
    key: 'identity.role.view',
    keys: ['identity.role.view'],
    ids: [ID, OTHER_ID],
    previous: null,
  };

  it('returns the jsonb form: instants with three fractional digits, null optionals', () => {
    expect(encodeAuditFields(fields, valid, KNOWN_KEYS)).toEqual({
      ok: true,
      value: { ...valid, at: '2026-10-08T01:02:03.004Z' },
    });
    expect(
      encodeAuditFields(
        { at: auditField.instant() },
        { at: Temporal.Instant.from('2026-10-08T00:00:00Z') },
        KNOWN_KEYS,
      ),
    ).toEqual({ ok: true, value: { at: '2026-10-08T00:00:00.000Z' } });
  });

  it.each([
    ['not an object', [], null, 'not-an-object'],
    ['an undeclared key, without naming it', { ...valid, email: 'x' }, null, 'undeclared'],
    ['a missing field', { ...valid, roleId: undefined }, 'roleId', 'missing'],
    [
      'a missing optional',
      Object.fromEntries(Object.entries(valid).filter(([name]) => name !== 'previous')),
      'previous',
      'missing',
    ],
    ['a malformed id', { ...valid, roleId: 'not-a-uuid' }, 'roleId', 'invalid'],
    ['an unknown enum value', { ...valid, state: 'gone' }, 'state', 'invalid'],
    ['a string for a boolean', { ...valid, founding: 'true' }, 'founding', 'invalid'],
    ['a fraction', { ...valid, count: 1.5 }, 'count', 'invalid'],
    ['an unsafe integer', { ...valid, count: 2 ** 53 }, 'count', 'invalid'],
    ['a Date for an instant', { ...valid, at: new Date() }, 'at', 'invalid'],
    [
      'a sub-millisecond instant',
      { ...valid, at: Temporal.Instant.fromEpochNanoseconds(1_000_000_001n) },
      'at',
      'invalid',
    ],
    ['an unknown permission key', { ...valid, key: 'identity.role.edit' }, 'key', 'invalid'],
    ['a list longer than its maximum', { ...valid, ids: [ID, ID, ID, ID] }, 'ids', 'too-long'],
    ['a bad item in a list', { ...valid, keys: ['nope'] }, 'keys', 'invalid'],
    ['a non-array list', { ...valid, ids: ID }, 'ids', 'invalid'],
    ['a malformed optional', { ...valid, previous: 'x' }, 'previous', 'invalid'],
  ])('refuses %s', (_case, values, field, problem) => {
    expect(encodeAuditFields(fields, values, KNOWN_KEYS)).toEqual({
      ok: false,
      error: { code: 'audit-fields.invalid', field, problem },
    });
  });

  it('accepts a list exactly at its maximum', () => {
    expect(encodeAuditFields(fields, { ...valid, ids: [ID, ID, ID] }, KNOWN_KEYS).ok).toBe(true);
  });

  describe('an instant is written by the prototype, not by the value (Hassan L1)', () => {
    const only = { at: auditField.instant() };
    const WHOLE = '2026-10-08T01:02:03.004Z';

    it('ignores the toString and epochNanoseconds of a subclass', () => {
      class Forged extends Temporal.Instant {
        override toString(): string {
          return 'not an instant';
        }
        override get epochNanoseconds(): bigint {
          return 0n;
        }
      }
      const whole = new Forged(Temporal.Instant.from(WHOLE).epochNanoseconds);
      // A sub-millisecond instant whose getter claims a whole millisecond.
      const fine = new Forged(1_000_000_001n);

      expect(encodeAuditFields(only, { at: whole }, KNOWN_KEYS)).toEqual({
        ok: true,
        value: { at: WHOLE },
      });
      expect(encodeAuditFields(only, { at: fine }, KNOWN_KEYS)).toEqual({
        ok: false,
        error: { code: 'audit-fields.invalid', field: 'at', problem: 'invalid' },
      });
    });

    it('refuses an object that only inherits from Temporal.Instant.prototype', () => {
      const fake = Object.create(Temporal.Instant.prototype, {
        toString: { value: () => WHOLE },
        epochNanoseconds: { value: 0n },
      }) as unknown;
      expect(fake instanceof Temporal.Instant).toBe(true);

      expect(encodeAuditFields(only, { at: fake }, KNOWN_KEYS)).toEqual({
        ok: false,
        error: { code: 'audit-fields.invalid', field: 'at', problem: 'invalid' },
      });
    });
  });

  describe('a list is copied once, then checked and encoded (Hassan L2)', () => {
    const only = { ids: auditField.listOf(auditField.id(), 2) };

    it('checks and encodes the same items however often a Proxy is read', () => {
      let reads = 0;
      // Two items at the first read of each index, a malformed id at any later read.
      const shifty = new Proxy([ID, OTHER_ID], {
        get(target, property, receiver) {
          if (property === '0' || property === '1') {
            reads += 1;
            return reads <= 2 ? (Reflect.get(target, property, receiver) as unknown) : 'not-an-id';
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });

      expect(encodeAuditFields(only, { ids: shifty }, KNOWN_KEYS)).toEqual({
        ok: true,
        value: { ids: [ID, OTHER_ID] },
      });
      expect(reads).toBe(2);
    });

    it('cannot be grown past the maximum by a length that changes between reads', () => {
      let lengthReads = 0;
      const growing = new Proxy([ID], {
        get(target, property, receiver) {
          if (property === 'length') {
            lengthReads += 1;
            return lengthReads === 1 ? 1 : 1_000_000;
          }
          return property === '0' || /^\d+$/.test(String(property))
            ? ID
            : (Reflect.get(target, property, receiver) as unknown);
        },
      });

      // One read of the length: the copy holds one item.
      expect(encodeAuditFields(only, { ids: growing }, KNOWN_KEYS)).toEqual({
        ok: true,
        value: { ids: [ID] },
      });
    });

    it('stops copying at the maximum plus one for a huge reported length', () => {
      const huge = new Proxy([] as string[], {
        get(target, property, receiver) {
          if (property === 'length') return 2 ** 32 - 1;
          return /^\d+$/.test(String(property))
            ? ID
            : (Reflect.get(target, property, receiver) as unknown);
        },
      });

      expect(encodeAuditFields(only, { ids: huge }, KNOWN_KEYS)).toEqual({
        ok: false,
        error: { code: 'audit-fields.invalid', field: 'ids', problem: 'too-long' },
      });
    });
  });
});

describe('a definition stores frozen kinds of its own (Hassan L3)', () => {
  /** Every object reachable from `value` through own properties is frozen. */
  function deeplyFrozen(value: unknown, seen = new Set<unknown>()): boolean {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return true;
    if (seen.has(value)) return true;
    seen.add(value);
    if (!Object.isFrozen(value)) return false;
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!;
      return 'value' in descriptor ? deeplyFrozen(descriptor.value, seen) : true;
    });
  }

  it('rebuilds kinds written as mutable literals, and the caller cannot change them later', () => {
    const values = ['open', 'closed'];
    const state = { kind: 'enumOf', values };
    const list = { kind: 'listOf', of: { kind: 'id' }, max: 4 };
    const target = { kind: 'enumOf', values: ['first-key', 'second-key'] };
    const definition = defineAuditAction({
      action: 'identity.market-setting.changed',
      targetType: 'identity.market-setting',
      targetId: target,
      actors: ['system'],
      before: { state, ids: list, maybe: { kind: 'optional', of: { kind: 'boolean' } } },
      after: { state: auditField.enumOf(['open', 'closed'] as const) },
    } as unknown as Parameters<typeof defineAuditAction>[0]);

    values.push('Free Text');
    state.kind = 'text';
    list.max = 1_000_000;
    target.values.push('Third');

    expect(deeplyFrozen(definition)).toBe(true);
    expect(definition.before).not.toBe(null);
    expect(definition.before?.state).not.toBe(state);
    expect(definition.before).toEqual({
      state: { kind: 'enumOf', values: ['open', 'closed'] },
      ids: { kind: 'listOf', of: { kind: 'id' }, max: 4 },
      maybe: { kind: 'optional', of: { kind: 'boolean' } },
    });
    expect(definition.targetId).toEqual({ kind: 'enumOf', values: ['first-key', 'second-key'] });
  });

  it('reads a getter kind once and keeps what it read', () => {
    let reads = 0;
    const flipping = {
      get kind() {
        reads += 1;
        return reads === 1 ? 'id' : 'text';
      },
    };
    const definition = defineAuditAction({
      action: 'identity.role.renamed',
      targetType: 'identity.role',
      actors: ['system'],
      after: { roleId: flipping },
    } as unknown as Parameters<typeof defineAuditAction>[0]);

    expect(reads).toBe(1);
    expect(definition.after).toEqual({ roleId: { kind: 'id' } });
    expect(deeplyFrozen(definition)).toBe(true);
  });

  it('is deeply frozen for every kind of the vocabulary', () => {
    expect(deeplyFrozen(roleAssigned)).toBe(true);
  });
});

describe('describeAuditAction (the catalogue snapshot)', () => {
  it('describes kinds, list maxima, sorted fields and sorted actors', () => {
    expect(describeAuditAction(roleAssigned)).toEqual({
      action: 'identity.account-role.assigned',
      targetType: 'identity.account',
      targetId: 'id',
      actors: ['anonymous', 'authenticated', 'system'],
      before: { roleId: 'optional(id)' },
      after: {
        boundSubjectId: 'id',
        founding: 'boolean',
        roleId: 'id',
        scope: 'enumOf(platform|seller)',
      },
    });
    const seeded = defineAuditAction({
      action: 'identity.role.seed-applied',
      targetType: 'identity.role',
      actors: ['system'],
      after: { addedKeys: auditField.listOf(auditField.permissionKey(), 64) },
    });
    expect(describeAuditAction(seeded)).toMatchObject({
      before: null,
      after: { addedKeys: 'listOf(permissionKey, max 64)' },
    });
  });
});
