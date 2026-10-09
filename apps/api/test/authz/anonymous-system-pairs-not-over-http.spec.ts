import 'reflect-metadata';
import { forwardRef, Inject } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APPROVED_SELLER_ZONES } from '../../src/modules/sellers/contracts/approved-seller-zones.contract';
import { CERTIFICATION_FACADE } from '../../src/modules/certification';
import { FindAccessDecisionsByBasis } from '../../src/modules/identity/application/use-cases/find-access-decisions-by-basis.use-case';
import { ListSellerAccessDecisions } from '../../src/modules/identity/application/use-cases/list-seller-access-decisions.use-case';
import { SELLER_ACCESS_CONTRACT } from '../../src/modules/identity/contracts/seller-access.contract';
import { SELLERS_FACADE } from '../../src/modules/sellers/contracts/sellers.facade';
import { ApprovedSellerZonesSystem } from '../../src/modules/sellers/application/use-cases/approved-seller-zones-system.use-case';
import { ApprovedSellerZones } from '../../src/modules/sellers/application/use-cases/approved-seller-zones.use-case';
import { accessDeclarationOf } from '../../src/platform/authz/access-rule';
import { UseCase } from '../../src/platform/authz/use-case';
import { createTestApp } from '../support/test-app';
import { readList } from './use-case-discovery';
import path from 'node:path';

// The CI check behind the hard precondition of sellers' approved-seller-zones contract (sellers
// design 11.1 slice 2; Hassan L4): the `anonymous` and `system` use cases are not reachable over
// HTTP unless they are on the checked-in allow-list. The check boots the real application and
// reads, for every controller Nest registers, the dependencies its constructor declares (the
// classes of `design:paramtypes` and the tokens of `@Inject`, and property injection). A use
// case with rule `anonymous` or `system` that a controller injects must be on
// test/contracts/http-reachable-anonymous-system.json, each entry with a reason; an entry that no
// controller injects any more is stale. The approved-seller-zones pair, its token and the
// sellers facade token may never be a controller dependency, listed or not.
//
// Limit: this is a check of direct controller dependencies. A controller that reached a
// use case through a helper provider of its own would not be seen here. Inside sellers the
// dependency-cruiser rule `approved-seller-zones-use-cases-stay-in-sellers-reader` keeps the pair's
// use-case files out of every file but the reader and the module, and the contract file's rule
// (`approved-seller-zones-contract-is-for-certification`) keeps the token out of other modules;
// rule 9 (`use-cases-are-the-only-way-in`) does not cover a controller -> helper provider ->
// use case path.

const LIST = path.resolve(__dirname, '../contracts/http-reachable-anonymous-system.json');
/** Nest's metadata keys for `@Inject` on constructor parameters and on properties. */
const SELF_DECLARED_DEPS = 'self:paramtypes';
const PROPERTY_DEPS = 'self:properties_metadata';

interface AllowedEntry {
  readonly name: string;
  readonly rule: 'anonymous' | 'system';
  readonly reason: string;
}

/** Everything a controller class asks Nest to inject: classes and `@Inject` tokens. */
function dependenciesOf(controller: object): unknown[] {
  const classes = (Reflect.getMetadata('design:paramtypes', controller) ?? []) as unknown[];
  const injected = (Reflect.getMetadata(SELF_DECLARED_DEPS, controller) ?? []) as {
    index: number;
    param: unknown;
  }[];
  const properties = (Reflect.getMetadata(PROPERTY_DEPS, controller) ?? []) as {
    type: unknown;
  }[];
  return [
    ...classes,
    ...injected.map((entry) => entry.param),
    ...properties.map((p) => p.type),
  ].map(unwrapForwardRef);
}

/** `@Inject(forwardRef(() => X))` stores `{ forwardRef: () => X }`; the dependency is X. */
function unwrapForwardRef(dependency: unknown): unknown {
  if (
    typeof dependency === 'object' &&
    dependency !== null &&
    typeof (dependency as { forwardRef?: unknown }).forwardRef === 'function'
  ) {
    return (dependency as { forwardRef: () => unknown }).forwardRef();
  }
  return dependency;
}

const isUseCaseClass = (value: unknown): value is typeof UseCase =>
  typeof value === 'function' && value.prototype instanceof UseCase;

describe('anonymous and system use cases are not reachable over HTTP', () => {
  let app: NestExpressApplication;
  const allowed = readList<AllowedEntry[]>(LIST);

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const controllers = (): { name: string; dependencies: unknown[] }[] =>
    [...app.get(ModulesContainer).values()].flatMap((moduleRef) =>
      [...moduleRef.controllers.values()]
        .map((wrapper) => wrapper.metatype as object)
        .map((controller) => ({
          name: (controller as { name: string }).name,
          dependencies: dependenciesOf(controller),
        })),
    );

  /** `[controller, use-case name, rule]` for every injected use case of rule anonymous/system. */
  const reachable = (): [string, string, string][] =>
    controllers().flatMap(({ name, dependencies }) =>
      dependencies.filter(isUseCaseClass).flatMap((useCase): [string, string, string][] => {
        const declared = accessDeclarationOf(useCase);
        if (!declared.ok) return [[name, `(undeclared ${useCase.name})`, 'invalid']];
        const { rule } = declared.value;
        return rule.kind === 'anonymous' || rule.kind === 'system'
          ? [[name, declared.value.name, rule.kind]]
          : [];
      }),
    );

  it('discovers the controllers and reads their dependencies', () => {
    const found = controllers();

    expect(found.map((controller) => controller.name)).toContain('CustomerSignUpController');
    expect(reachable().length).toBeGreaterThan(0);
  });

  it('lists every reachable anonymous or system use case, and nothing stale', () => {
    const names = new Set(reachable().map(([, useCase]) => useCase));

    expect(allowed.map((entry) => entry.name)).toEqual([...allowed.map((e) => e.name)].sort());
    expect(allowed.filter((entry) => entry.reason.trim() === '')).toEqual([]);
    expect([...names].filter((name) => !allowed.some((e) => e.name === name)).sort()).toEqual([]);
    expect(allowed.filter((entry) => !names.has(entry.name))).toEqual([]);
  });

  it('lists the rule of each entry as the use case declares it', () => {
    const rules = new Map(reachable().map(([, useCase, rule]) => [useCase, rule]));

    expect(allowed.filter((entry) => rules.get(entry.name) !== entry.rule)).toEqual([]);
  });

  it('never lets a controller depend on the certification facade (its use cases are anonymous and system)', () => {
    const offenders = controllers()
      .filter(({ dependencies }) => dependencies.includes(CERTIFICATION_FACADE))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('never lets a controller depend on the approved-seller-zones pair, its token or the sellers facade', () => {
    const forbidden = new Set<unknown>([
      ApprovedSellerZones,
      ApprovedSellerZonesSystem,
      APPROVED_SELLER_ZONES,
      SELLERS_FACADE,
    ]);

    const offenders = controllers()
      .filter(({ dependencies }) => dependencies.some((dependency) => forbidden.has(dependency)))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
    expect(
      allowed.filter((entry) => entry.name.startsWith('sellers.approved-seller-zones')),
    ).toEqual([]);
  });

  it('never lets a controller depend on the R-5 decision reads or the seller-access contract (identity slice 9a; Hassan C1)', () => {
    // `ListSellerAccessDecisions` is a `permissions` use case, so the list check above would not
    // see it: it is named here. Both answer only through the contract, which only sellers uses.
    const forbidden = new Set<unknown>([
      ListSellerAccessDecisions,
      FindAccessDecisionsByBasis,
      SELLER_ACCESS_CONTRACT,
    ]);

    const offenders = controllers()
      .filter(({ dependencies }) => dependencies.some((dependency) => forbidden.has(dependency)))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
    expect(
      allowed.filter((entry) => entry.name === 'identity.find-access-decisions-by-basis'),
    ).toEqual([]);
    expect(
      [ListSellerAccessDecisions, FindAccessDecisionsByBasis].map((useCase) => {
        const declared = accessDeclarationOf(useCase);
        return declared.ok ? declared.value.rule.kind : declared.error.code;
      }),
    ).toEqual(['permissions', 'system']);
  });

  it('still declares the approved-seller-zones pair as anonymous and system, so the check has teeth', () => {
    const rule = (useCase: typeof ApprovedSellerZones | typeof ApprovedSellerZonesSystem) => {
      const declared = accessDeclarationOf(useCase);
      return declared.ok ? declared.value.rule.kind : declared.error.code;
    };

    expect([rule(ApprovedSellerZones), rule(ApprovedSellerZonesSystem)]).toEqual([
      'anonymous',
      'system',
    ]);
  });

  it('would see a controller that injected the pair, with real Nest decorators', () => {
    class Canary {
      @Inject(APPROVED_SELLER_ZONES)
      readonly byProperty!: unknown;

      constructor(
        readonly byClass: ApprovedSellerZones,
        @Inject(APPROVED_SELLER_ZONES) readonly byToken: unknown,
        @Inject(forwardRef(() => ApprovedSellerZonesSystem)) readonly byForwardRef: unknown,
      ) {}
    }

    const dependencies = dependenciesOf(Canary);

    // The class typed parameter, the @Inject token on a parameter, the @Inject token on a
    // property and the unwrapped forwardRef are all seen; a renamed Nest metadata key breaks this.
    expect(dependencies).toContain(ApprovedSellerZones);
    expect(dependencies.filter((d) => d === APPROVED_SELLER_ZONES)).toHaveLength(2);
    expect(dependencies).toContain(ApprovedSellerZonesSystem);
  });
});
