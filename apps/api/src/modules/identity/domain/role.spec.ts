import { parseId, parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, Population } from '@mondapac/shared-kernel';
import {
  Role,
  RoleAssignment,
  RoleInvariantError,
  scopeOfPopulation,
  type RoleAssignmentState,
  type RoleState,
} from './role';

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');

function id<K extends string>(text: string): Id<K> {
  const parsed = parseId<K>(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}

const ROLE_ID = id<'Role'>('01990000-0000-7000-8000-0000000000d1');
const ASSIGNMENT_ID = id<'RoleAssignment'>('01990000-0000-7000-8000-0000000000e1');
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');

describe.each(['AU', 'ZZ'])('Role and RoleAssignment in market %s (identity design 2.1, 5.5)', (code) => {
  const marketId = market(code);
  const systemRole = (scope: 'platform' | 'seller') =>
    Role.seedSystem({
      id: ROLE_ID,
      marketId,
      scope,
      seedCode: scope === 'seller' ? 'seller-owner' : 'platform-administrator',
      seedVersion: 1,
      now: NOW,
    });

  describe('Role.seedSystem (R3; 5.6)', () => {
    it('is a seeded system row of one scope, with no stored keys and no seller', () => {
      expect(systemRole('seller').state).toEqual<RoleState>({
        id: ROLE_ID,
        marketId,
        scope: 'seller',
        kind: 'system',
        seedCode: 'seller-owner',
        seedVersion: 1,
        sellerId: null,
        version: 1,
        createdAt: NOW,
      });
      expect(systemRole('seller').isSystem).toBe(true);
    });

    it.each([
      ['a seed code that is not a code', { seedCode: 'Seller Owner' }],
      ['seed version 0', { seedVersion: 0 }],
      ['an unknown scope', { scope: 'customer' }],
    ] as const)('refuses %s', (_name, overrides) => {
      expect(() =>
        Role.seedSystem({
          id: ROLE_ID,
          marketId,
          scope: 'seller',
          seedCode: 'seller-owner',
          seedVersion: 1,
          now: NOW,
          ...(overrides as object),
        }),
      ).toThrow(RoleInvariantError);
    });

    it('refuses to restore a system role with a seller (R9: only custom seller roles have one)', () => {
      expect(() =>
        Role.restore({
          ...systemRole('seller').state,
          sellerId: id<'Seller'>('01990000-0000-7000-8000-0000000000a1'),
        }),
      ).toThrow(RoleInvariantError);
    });
  });

  describe('scopeOfPopulation (R2)', () => {
    it.each<[Population, 'platform' | 'seller' | null]>([
      ['seller', 'seller'],
      ['admin', 'platform'],
      ['customer', null],
    ])('%s -> %s', (population, scope) => {
      expect(scopeOfPopulation(population)).toBe(scope);
    });
  });

  describe('RoleAssignment.found (founding assignment, 5.5)', () => {
    it('gives the system role of the matching scope, with no assigner, version 1', () => {
      const assignment = RoleAssignment.found({
        id: ASSIGNMENT_ID,
        account: { id: ACCOUNT_ID, marketId, population: 'seller' },
        role: systemRole('seller'),
        now: NOW,
      });

      expect(assignment.state).toEqual<RoleAssignmentState>({
        id: ASSIGNMENT_ID,
        marketId,
        accountId: ACCOUNT_ID,
        roleId: ROLE_ID,
        assignedByAccountId: null,
        assignedAt: NOW,
        version: 1,
      });
      expect(assignment.persistedVersion).toBeNull();
    });

    it.each<[string, Population, 'platform' | 'seller']>([
      ['a customer, whatever the role (R2)', 'customer', 'seller'],
      ['a seller account a platform role', 'seller', 'platform'],
      ['an admin account a seller role', 'admin', 'seller'],
    ])('refuses %s', (_name, population, scope) => {
      expect(() =>
        RoleAssignment.found({
          id: ASSIGNMENT_ID,
          account: { id: ACCOUNT_ID, marketId, population },
          role: systemRole(scope),
          now: NOW,
        }),
      ).toThrow(RoleInvariantError);
    });

    it('refuses a role of another Market', () => {
      const other = market(code === 'AU' ? 'ZZ' : 'AU');

      expect(() =>
        RoleAssignment.found({
          id: ASSIGNMENT_ID,
          account: { id: ACCOUNT_ID, marketId: other, population: 'seller' },
          role: systemRole('seller'),
          now: NOW,
        }),
      ).toThrow(RoleInvariantError);
    });
  });
});
