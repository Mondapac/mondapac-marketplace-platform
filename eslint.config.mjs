// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Market and vertical identifiers that must never appear as literals in core code: they
// belong in Market/Vertical configuration or a strategy implementation (ADR-0001 decision 5,
// ADR-0003 decision 2, ADR-0008 decision 6). Extend the list when a market or vertical is added.
const MARKET_OR_VERTICAL_LITERAL = '\\b(AU|AUD|en-AU|[Hh]alal|HALAL)\\b';
const noMarketOrVerticalLiterals = [
  {
    selector: `Literal[value=/${MARKET_OR_VERTICAL_LITERAL}/]`,
    message:
      'Market or vertical identifier hardcoded in core code. Move it to Market/Vertical configuration or a strategy implementation.',
  },
  {
    selector: `TemplateElement[value.raw=/${MARKET_OR_VERTICAL_LITERAL}/]`,
    message:
      'Market or vertical identifier hardcoded in core code. Move it to Market/Vertical configuration or a strategy implementation.',
  },
];

// Boundary rules of platform-foundations design 8.2 that ESLint enforces (rules 4, 5 and 7)
// and the attach rule of the slice 0 security review. `no-restricted-syntax` and
// `no-restricted-imports` carry no rule names of their own, so every message starts with the
// design's rule name. Deliberate violations in apps/api/test/boundary-fixtures/ are asserted
// by apps/api/test/boundaries.spec.ts.

// Rule 4, no-wall-clock: only platform/clock/ reads the wall clock (ADR-0005 decision 5).
const WALL_CLOCK = 'take the current time from the injected Clock; only platform/clock/ reads it.';
const noWallClock = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: `no-wall-clock: new Date() reads the wall clock: ${WALL_CLOCK}`,
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: `no-wall-clock: Date() reads the wall clock: ${WALL_CLOCK}`,
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: `no-wall-clock: Date.now() reads the wall clock: ${WALL_CLOCK}`,
  },
  {
    selector: "MemberExpression[object.name='Temporal'][property.name='Now']",
    message: `no-wall-clock: Temporal.Now reads the wall clock: ${WALL_CLOCK}`,
  },
];
// Rule 4, second part: domain/ and application/ use the kernel's Temporal types only; a
// repository converts an Instant with `new Date(value)` (design 3.2).
const noDateConversion = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length>0]",
    message:
      'no-wall-clock: no Date in domain/ or application/: use the Temporal types of the shared ' +
      'kernel. A repository in infrastructure/ converts with new Date(value).',
  },
];

// TypeScript sources of every kind: a block lints only the extensions it names, and
// boundaries.spec.ts checks that apps/api/src and the kernel's src hold no other kind.
const TS = '{ts,mts,cts}';
const SPEC_FILES = [`**/*.spec.${TS}`];
// The fixture tree is outside the globs below, so each block names its fixture files too.
const FIXTURES = 'apps/api/test/boundary-fixtures';

/**
 * Forbids a name however it arrives: a named import (also renamed), a re-export, a member
 * of a namespace import (also computed with a literal), a qualified type name or a
 * destructured property. Matching the name rather than the import path also catches a
 * barrel.
 */
function forbidNames(names, message) {
  const name = `/^(${names.join('|')})$/`;
  return [
    `ImportSpecifier:matches([imported.name=${name}], [imported.value=${name}])`,
    `ExportSpecifier:matches([local.name=${name}], [local.value=${name}])`,
    `MemberExpression:matches([property.name=${name}], [property.value=${name}])`,
    `TSQualifiedName[right.name=${name}]`,
    `ObjectPattern > Property:matches([key.name=${name}], [key.value=${name}])`,
  ].map((selector) => ({ selector, message }));
}

// Rule 5, contexts-are-minted-by-platform (design 3.7): a module never mints a context and
// never asserts a value to a context type; it receives the context from its entry adapter.
// Slice 1 adds the actor and CallContext constructors and types (one file of identity may
// then call the authenticated-actor constructor). Lint is a guard rail here: a literal can
// still reach a context parameter through `as any`, a type alias or an untyped value, so the
// run-time control is the kernel's isMinted check. The dependency-cruiser rule
// market-context-only-through-the-decorator closes the paths to the factory, and
// contextImportsOfModules closes namespace imports, `export *` and provider discovery.
const CONTEXT_CONSTRUCTORS = ['mintMarketContext', 'MarketContextFactory'];
const CONTEXT_TYPES = ['MarketContext'];
const MINTED_BY_PLATFORM =
  'contexts-are-minted-by-platform: a module never mints a context; it receives one from ' +
  'its platform entry adapter.';
const contextsAreMintedByPlatform = [
  ...forbidNames(CONTEXT_CONSTRUCTORS, MINTED_BY_PLATFORM),
  {
    selector: `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation Identifier[name=/^(${CONTEXT_TYPES.join('|')})$/]`,
    message:
      'contexts-are-minted-by-platform: a module never asserts a value to a context type; a ' +
      'context is minted by the platform.',
  },
];
// The same rule as import restrictions of the modules (a separate rule key, so the
// no-restricted-syntax blocks do not replace it). With importNames, a namespace import and
// an `export *` of the package are reported too. Provider discovery would hand a module the
// global factory without naming it.
const contextImportsOfModules = [
  'error',
  {
    paths: [
      {
        name: '@mondapac/shared-kernel',
        importNames: ['mintMarketContext'],
        message: MINTED_BY_PLATFORM,
      },
      {
        name: '@nestjs/core',
        importNames: ['DiscoveryService', 'DiscoveryModule', 'ModulesContainer'],
        message:
          'contexts-are-minted-by-platform: a module injects what it needs and never ' +
          "discovers providers, the platform's factory included.",
      },
    ],
  },
];

// P 12.2 rule 4, no-raw-sql-or-transaction-in-modules: raw SQL and $transaction belong to the
// platform (UnitOfWork); a module reaches the database through the unit-of-work port. It is part
// of both module groups below, because a later block replaces the whole rule value.
const noRawSqlOrTransactionInModules = [
  {
    selector:
      'MemberExpression[property.name=/^\\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|queryRawTyped|transaction)$/]',
    message:
      'no-raw-sql-or-transaction-in-modules: Raw SQL and $transaction are platform-only (P 12.2 rule 4).',
  },
];

// Security review of slice 0: only MarketContextGuard attaches a request's MarketContext.
const onlyTheGuardAttaches = forbidNames(
  ['attachMarketContext'],
  'only-the-guard-attaches-market-context: attachMarketContext is called by ' +
    'MarketContextGuard only; read the Market with @Market().',
);

// Security review of slice 0 item 4 (M3), imports-are-static: code is loaded by a static
// import only, which pnpm boundaries sees. A computed import(), require, createRequire,
// process.mainModule and a direct eval (which sees the module's require) load code past every
// rule of this file and of dependency-cruiser.
const STATIC_IMPORTS =
  'imports-are-static: load code with a static import, so that pnpm boundaries sees it';
const codeLoaders = [
  { selector: "Identifier[name='require']", message: `${STATIC_IMPORTS} (no require).` },
  ...forbidNames(
    ['createRequire', 'mainModule'],
    `${STATIC_IMPORTS} (no createRequire or mainModule).`,
  ),
  { selector: "CallExpression[callee.name='eval']", message: `${STATIC_IMPORTS} (no eval).` },
];
const staticImportsOnly = [
  {
    selector: "ImportExpression[source.type!='Literal']",
    message: `${STATIC_IMPORTS} (no computed import()).`,
  },
  ...codeLoaders,
];
// Modules have no import() at all: the value of a dynamic import of the kernel, indexed with a
// computed name, would reach mintMarketContext past every name check of rule 5.
const moduleStaticImportsOnly = [
  {
    selector: 'ImportExpression',
    message:
      'imports-are-static: no import() in a module; import statically, so that the context ' +
      'rules see every name.',
  },
  ...codeLoaders,
];
// Rule 7 in the kernel: no import() at all, so the whitelist below cannot be passed by a
// dynamic import of a literal either.
const kernelStaticImportsOnly = [
  {
    selector: 'ImportExpression',
    message:
      'kernel-imports-only-itself: no import() in the shared kernel; import its own files statically.',
  },
  ...codeLoaders,
];

// Rule 7, kernel-imports-only-itself (ADR-0008 decision 1): a whitelist. The kernel imports
// only its own files (`./name`, never `..`); time.ts alone may also import the polyfill
// (ADR-0020 decision 7). Each regex matches what is refused.
const kernelImports = (regex) => [
  'error',
  {
    patterns: [
      {
        regex,
        message:
          'kernel-imports-only-itself: the shared kernel imports only its own files; time.ts ' +
          'alone may import temporal-polyfill. No Node API, package or framework.',
      },
    ],
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'Claude outputs/**',
      '**/generated/**',
      // Deliberate violations used by apps/api/test/boundaries.spec.ts.
      '**/test/boundary-fixtures/**',
      // The Figma plugin is design tooling (ADR-0017): it runs inside Figma with Figma's
      // globals, has its own test runner (docs/design/figma/plugin/test/) and its code.js
      // is generated by build.py. It is not part of the platform code this config guards.
      'docs/design/figma/plugin/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: [`**/*.${TS}`],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // no-restricted-syntax: a later block replaces the selectors of an earlier one, so each
  // block lists every group that applies to its files.
  {
    // All code of the API: the attach rule and static imports.
    files: [`apps/api/src/**/*.${TS}`, `${FIXTURES}/src/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: { 'no-restricted-syntax': ['error', ...onlyTheGuardAttaches, ...staticImportsOnly] },
  },
  {
    // The shared kernel.
    files: [
      `packages/shared-kernel/src/**/*.${TS}`,
      `${FIXTURES}/packages/shared-kernel/src/**/*.${TS}`,
    ],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...kernelStaticImportsOnly,
      ],
    },
  },
  {
    // Platform runtime.
    files: [`**/src/platform/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...onlyTheGuardAttaches,
        ...staticImportsOnly,
      ],
    },
  },
  {
    // The only reader of the wall clock.
    files: [`**/src/platform/clock/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...onlyTheGuardAttaches,
        ...staticImportsOnly,
      ],
    },
  },
  {
    // The only file that attaches a request's MarketContext.
    files: ['**/src/platform/market-context/market-context.guard.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...staticImportsOnly,
      ],
    },
  },
  {
    // Modules.
    files: [`**/src/modules/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...onlyTheGuardAttaches,
        ...contextsAreMintedByPlatform,
        ...noRawSqlOrTransactionInModules,
        ...moduleStaticImportsOnly,
      ],
      '@typescript-eslint/no-restricted-imports': contextImportsOfModules,
    },
  },
  {
    // The domain and application layers of a module.
    files: [`**/src/modules/*/domain/**/*.${TS}`, `**/src/modules/*/application/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...noDateConversion,
        ...onlyTheGuardAttaches,
        ...contextsAreMintedByPlatform,
        ...noRawSqlOrTransactionInModules,
        ...moduleStaticImportsOnly,
      ],
    },
  },
  {
    // The shared kernel is framework-free and used by both api and web (ADR-0008), spec
    // files included.
    files: [
      `packages/shared-kernel/src/**/*.${TS}`,
      `${FIXTURES}/packages/shared-kernel/src/**/*.${TS}`,
    ],
    rules: { 'no-restricted-imports': kernelImports('^(?!\\./)|\\.\\.') },
  },
  {
    files: ['packages/shared-kernel/src/time.ts', `${FIXTURES}/packages/shared-kernel/src/time.ts`],
    rules: { 'no-restricted-imports': kernelImports('^(?!\\./|temporal-polyfill$)|\\.\\.') },
  },
  {
    files: [...SPEC_FILES, `**/test/**/*.${TS}`],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
