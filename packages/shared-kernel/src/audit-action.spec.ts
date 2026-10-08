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
