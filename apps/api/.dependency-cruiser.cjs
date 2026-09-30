/**
 * Architecture boundaries of the modular monolith, enforced in CI (ADR-0008 decision 6,
 * ADR-0004 decision 3). Paths are relative to apps/api.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
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
      name: 'prisma-service-only-in-infrastructure',
      comment:
        'PrismaService is the Prisma client: only modules/<m>/infrastructure/ and ' +
        'platform/persistence/ may import it. Other code uses a repository or DatabaseProbe.',
      severity: 'error',
      from: {
        pathNot: ['^src/modules/[^/]+/infrastructure/', '^src/platform/persistence/'],
      },
      to: { path: '^src/platform/persistence/prisma\\.service\\.ts$' },
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
