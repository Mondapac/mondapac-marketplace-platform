// Architecture boundaries of the modular monolith, enforced in CI (ADR-0008 decision 6,
// ADR-0004 decision 3). Paths are relative to apps/api; the shared kernel, reached through
// the `paths` of tsconfig.json, appears as `../../packages/shared-kernel/...`. Every rule has
// a deliberate violation in test/boundary-fixtures/, asserted by test/boundaries.spec.ts.
// The rule numbers in comments are those of platform-foundations design 8.2.

// Modules that `identity` may import, through their index.ts only. Empty by decision
// (ADR-0018 decision 4, ADR-0020 A9): `legal` joins only by a named decision at its gate.
const IDENTITY_MAY_IMPORT = [];

// The file of `@NoMarketContext()` and the only files that may import it (design 8.2 rule 6,
// CTO decision of slice 0 item 3): the guard reads the exemption, the health controller uses
// it. Both files export only their own names (asserted in boundaries.spec.ts).
const MARKET_EXEMPTION_FILE = '^src/platform/market-context/no-market-context\\.decorator\\.ts$';
const MARKET_EXEMPTION_IMPORTERS = [
  '^src/platform/market-context/market-context\\.guard\\.ts$',
  '^src/platform/health/health\\.controller\\.ts$',
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // Rule 1.
      name: 'platform-does-not-import-modules',
      comment:
        'platform/ is below the modules: it may not import any module, not even through its ' +
        "index.ts (ADR-0018 decision 4). Modules implement platform's ports instead.",
      severity: 'error',
      from: { path: '^src/platform/' },
      to: { path: '^src/modules/' },
    },
    {
      // Rule 2.
      name: 'identity-imports-no-module',
      comment:
        'identity imports no other module, not even through its index.ts (identity brief R7, ' +
        'ADR-0018 decision 4, ADR-0020 A9). The allow-list IDENTITY_MAY_IMPORT is empty.',
      severity: 'error',
      from: { path: '^src/modules/identity/' },
      to: {
        path: '^src/modules/',
        pathNot: [
          '^src/modules/identity/',
          ...IDENTITY_MAY_IMPORT.map((module) => `^src/modules/${module}/index\\.ts$`),
        ],
      },
    },
    {
      // Rule 3.
      name: 'temporal-only-through-kernel',
      comment:
        'Temporal comes from @mondapac/shared-kernel only (ADR-0015 decision 4, ADR-0020 ' +
        'decision 7). The pattern matches the bare specifier, because pnpm does not resolve ' +
        'the polyfill from apps/api, and also a resolved path, should hoisting ever change.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '(^|/node_modules/)(temporal-polyfill|@js-temporal/polyfill)(/|$)' },
    },
    {
      // Rule 6.
      name: 'market-exemption-is-platform-only',
      comment:
        'Only the market guard and the health controller may import @NoMarketContext() (ADR-0015 ' +
        'decision 3: only health and docs are exempt). An allow-list of importers, so that a ' +
        're-export cannot carry the exemption elsewhere.',
      severity: 'error',
      from: { pathNot: MARKET_EXEMPTION_IMPORTERS },
      to: { path: MARKET_EXEMPTION_FILE },
    },
    {
      // Not in 8.2: the security review of slice 0 item 4 (M2). The factory is global, so the
      // import rules alone did not stop a module from reaching it through MarketContextModule,
      // a barrel or Nest's metadata, or from copying the health controller's exemption.
      name: 'market-context-only-through-the-decorator',
      comment:
        'A module takes its Market from @Market() and imports nothing else from ' +
        'platform/market-context/ or platform/health/: no factory, module, guard, tenant, ' +
        'exemption or health controller.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: {
        path: '^src/platform/(market-context|health)/',
        pathNot: '^src/platform/market-context/market\\.decorator\\.ts$',
      },
    },
    {
      // Rule 8.
      name: 'kernel-testing-only-in-tests',
      comment:
        'The fakes of @mondapac/shared-kernel/testing are never bound in a running process: ' +
        'src/ (spec files are excluded) and the kernel itself may not import them. The subpath ' +
        "resolves through tsconfig.json's paths to the kernel's src/testing.ts; dist/ and the " +
        'bare specifier are matched as well.',
      severity: 'error',
      from: { path: ['^src/', 'packages/shared-kernel/src/'] },
      to: {
        path: [
          'packages/shared-kernel/src/testing\\.ts$',
          'packages/shared-kernel/dist/testing\\.(js|d\\.ts)$',
          '^@mondapac/shared-kernel/testing$',
        ],
      },
    },
    {
      // Not in 8.2: Bagher's (qc-release-manager) condition (a) for slice 0 item 4.
      name: 'kernel-only-through-package-entries',
      comment:
        'Outside the kernel, code reaches it only by its package names @mondapac/shared-kernel ' +
        'and @mondapac/shared-kernel/testing, never by a path into its src/ or dist/ and never ' +
        'by a deeper subpath: minting must stay inside the kernel, in one copy per process.',
      severity: 'error',
      from: { pathNot: 'packages/shared-kernel/' },
      to: {
        path: [
          'packages/shared-kernel/(src|dist)/',
          '^@mondapac/shared-kernel/(?!(testing|contexts)$)',
        ],
        // The package names resolve through tsconfig.json's paths, which marks them aliased.
        dependencyTypesNot: ['aliased'],
      },
    },
    {
      // Rule 5 of 8.2 for the slice 1c constructors (identity slice 1c; foundations 3.7, 5.2).
      // ESLint's rule 5 matches names; this rule closes the entry itself, so no import form,
      // barrel or alias outside platform/ reaches the constructors.
      name: 'contexts-are-built-by-platform',
      comment:
        'Only the platform entry adapters build actors and call contexts: nothing outside ' +
        'src/platform/ imports @mondapac/shared-kernel/contexts. A module receives its ' +
        'CallContext from the adapter that called it; it never mints a system actor.',
      severity: 'error',
      from: { pathNot: ['^src/platform/', 'packages/shared-kernel/'] },
      to: {
        path: [
          'packages/shared-kernel/src/contexts\\.ts$',
          'packages/shared-kernel/dist/contexts\\.(js|d\\.ts)$',
          '^@mondapac/shared-kernel/contexts$',
        ],
      },
    },
    {
      // Rule 9 of 8.2, first half (identity design 5.2; foundations 6.4 row 2).
      name: 'use-cases-are-the-only-way-in',
      comment:
        'An entry point of a module (presentation/, which holds controllers, jobs/ and ' +
        'subscribers/; contracts/; and every *.facade.ts implementation) imports from its ' +
        "module's application/ only use-cases/*.use-case.ts, so the UseCaseGate runs for " +
        'everything an entry point reaches.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/(?:presentation/|contracts/|.+\\.facade\\.ts$)' },
      to: {
        path: '^src/modules/$1/application/',
        pathNot: '^src/modules/$1/application/use-cases/[^/]+\\.use-case\\.ts$',
      },
    },
    {
      // Rule 9 of 8.2, second half (identity design 5.2).
      name: 'repositories-stay-behind-use-cases',
      comment:
        'A repository (a *.repository.ts file) is imported only by application/ and ' +
        "infrastructure/ of a module, and by the module's Nest module, which binds the " +
        'implementation to its port. Controllers, jobs, subscribers and facades go through a ' +
        'use case.',
      severity: 'error',
      from: {
        pathNot: [
          '^src/modules/[^/]+/(application|infrastructure)/',
          '^src/modules/[^/]+/[^/]+\\.module\\.ts$',
        ],
      },
      to: { path: '^src/modules/[^/]+/.+\\.repository\\.ts$' },
    },
    {
      name: 'module-public-api-only',
      comment: "A module may import another module only through that module's index.ts.",
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'module-internals-are-private',
      comment: 'Code outside modules/ may import a module only through its index.ts.',
      severity: 'error',
      from: { pathNot: '^src/modules/' },
      to: { path: '^src/modules/[^/]+/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'domain-is-pure',
      comment:
        'domain/ holds pure business rules: it may import only its own domain/ and the ' +
        'shared kernel. No NestJS, no Prisma, no I/O, no other layer.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/domain/' },
      // The kernel arrives through tsconfig.json's paths (positive fixture: domain/uses-kernel.ts).
      to: { pathNot: ['^src/modules/$1/domain/', 'packages/shared-kernel/'] },
    },
    {
      name: 'application-does-not-know-delivery',
      comment: 'application/ defines ports; it may not import infrastructure/ or presentation/.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/application/' },
      to: { path: '^src/modules/[^/]+/(infrastructure|presentation)/' },
    },
    {
      name: 'core-does-not-import-verticals',
      comment: 'Core (modules/, platform/) must not depend on any vertical (ADR-0001).',
      severity: 'error',
      from: { path: '^src/(modules|platform)/' },
      to: { path: '^src/verticals/' },
    },
    {
      name: 'prisma-only-in-infrastructure',
      comment:
        'The Prisma client is imported only from modules/<m>/infrastructure/ and ' +
        'platform/persistence/ (ADR-0004 decision 3).',
      severity: 'error',
      from: {
        pathNot: [
          '^src/modules/[^/]+/infrastructure/',
          '^src/platform/persistence/',
          '^src/generated/',
        ],
      },
      to: { path: ['^src/generated/', 'node_modules/@prisma/'] },
    },
    {
      name: 'persistence-internals-are-private',
      comment:
        'PrismaService is the door to the database. Outside modules/<m>/infrastructure/ and ' +
        'platform/persistence/, code may import only PersistenceModule, DatabaseProbe and ' +
        'the error reducer of platform persistence design 12.3 (it imports no Prisma) from ' +
        'platform/persistence/, so a re-export cannot leak the client.',
      severity: 'error',
      from: {
        pathNot: ['^src/modules/[^/]+/infrastructure/', '^src/platform/persistence/'],
      },
      to: {
        path: '^src/platform/persistence/',
        pathNot:
          '^src/platform/persistence/(persistence\\.module|database-probe|database-error)\\.ts$',
      },
    },
    {
      // Platform persistence design 12.2, rule 2.
      name: 'persistence-root-is-private',
      comment:
        "A module's infrastructure/ imports nothing of platform/persistence/ but " +
        'prisma.service.ts: never the base client (PrismaRoot), the guarded client, the ' +
        'unit store or the guard, so its only door to the database is tx(market).',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/infrastructure/' },
      to: {
        path: '^src/platform/persistence/',
        pathNot: '^src/platform/persistence/prisma\\.service\\.ts$',
      },
    },
    {
      name: 'database-driver-only-in-infrastructure',
      comment: 'The PostgreSQL driver is used only by infrastructure/ and platform/persistence/.',
      severity: 'error',
      from: {
        pathNot: [
          '^src/modules/[^/]+/infrastructure/',
          '^src/platform/persistence/',
          '^src/generated/',
        ],
      },
      to: { path: 'node_modules/(pg|pg-[^/]+|@types/pg)/' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies hide coupling between files and modules.',
      severity: 'error',
      from: { pathNot: '^src/generated/' },
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
  },
};
