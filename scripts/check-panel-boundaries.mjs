// Panel boundaries (ADR-0034 decisions 8 and 9). Run by `pnpm boundaries`, so by `pnpm verify`
// and CI. Reads the import and export specifiers of apps/seller, apps/admin and packages/ui:
//   - an app imports neither apps/api (@mondapac/api) nor the other app;
//   - packages/ui imports no app and not apps/api;
//   - the panels use the shared kernel through its main entry only, and only its value types:
//     never ActorContext, CallContext or the minted-context types (server-side, ADR-0020);
//   - no relative import leaves its package;
//   - a server file of an app (under app/ or src/server/, without 'use client') takes only
//     components and types from a relative 'use client' module. Any other value it imports from
//     one is a client reference on the server: calling it throws at render ("Attempted to call
//     x() from the server but x is on the client"), and a constant is not its value, so a
//     permission check against it is silently false. Such helpers belong in a plain module.
//
// Usage: node scripts/check-panel-boundaries.mjs [repo-root]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const PACKAGES = ['apps/seller', 'apps/admin', 'apps/web', 'packages/ui', 'packages/panel-server'];
const SERVER_ONLY_KERNEL_NAMES = new Set([
  'ActorContext',
  'AnonymousActor',
  'AuthenticatedActor',
  'SystemActor',
  'CallContext',
  'MarketContext',
  'mintMarketContext',
  'anonymousActor',
  'systemActor',
  'authenticatedActor',
  'createCallContext',
]);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);
const NEXT_APPS = new Set(['apps/seller', 'apps/admin', 'apps/web']);
/** A component name: PascalCase with a lower-case letter, so not a SCREAMING_CASE constant. */
const COMPONENT_NAME = /^[A-Z](?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]*$/;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx|mts|mjs|js|cjs)$/.test(entry.name) && entry.name !== 'next-env.d.ts')
      yield full;
  }
}

function parse(file, text) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** The file starts with the 'use client' directive. */
function isClientModule(source) {
  const first = source.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  );
}

const clientModuleCache = new Map();
/** Whether a relative specifier of `file` resolves to a 'use client' module of the repo. */
function importsClientModule(file, specifier) {
  for (const suffix of RESOLVE_SUFFIXES) {
    const target = path.resolve(path.dirname(file), specifier) + suffix;
    if (!existsSync(target) || !/\.(ts|tsx)$/.test(target)) continue;
    if (!clientModuleCache.has(target))
      clientModuleCache.set(target, isClientModule(parse(target, readFileSync(target, 'utf8'))));
    return clientModuleCache.get(target);
  }
  return false;
}

/** A server file of a Next app: under app/ or src/server/, not a test, not 'use client'. */
function isServerFile(pkg, rel, source) {
  if (!NEXT_APPS.has(pkg) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(rel)) return false;
  const inPkg = path.relative(pkg, rel).split(path.sep);
  const serverPlace = inPkg[0] === 'app' || (inPkg[0] === 'src' && inPkg[1] === 'server');
  return serverPlace && !isClientModule(source);
}

/** Names a declaration takes as values (type-only imports and specifiers left out). */
function valueNamesOf(node) {
  if (!ts.isImportDeclaration(node) || node.importClause === undefined) return [];
  const clause = node.importClause;
  if (clause.isTypeOnly) return [];
  const names = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(`* as ${bindings.name.text}`);
  if (bindings && ts.isNamedImports(bindings))
    for (const e of bindings.elements)
      if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text);
  return names;
}

/** Specifiers of a file with the names each import takes (null when it takes none by name). */
function importsOf(file, text, source = parse(file, text)) {
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      const names =
        clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause))
          ? clause.elements.map((e) => (e.propertyName ?? e.name).text)
          : null;
      found.push({ specifier: node.moduleSpecifier.text, names, values: valueNamesOf(node) });
    } else if (
      ts.isImportExpression?.(node) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      const arg = node.arguments[0];
      found.push({
        specifier: arg && ts.isStringLiteral(arg) ? arg.text : '<computed>',
        names: null,
        values: [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const violations = [];
for (const pkg of PACKAGES) {
  const pkgDir = path.join(root, pkg);
  if (!existsSync(pkgDir)) continue;
  const isUi = pkg === 'packages/ui';
  const self = `@mondapac/${path.basename(pkg)}`;
  for (const file of sourceFiles(pkgDir)) {
    const rel = path.relative(root, file);
    const text = readFileSync(file, 'utf8');
    const source = parse(file, text);
    const serverFile = isServerFile(pkg, rel, source);
    for (const { specifier, names, values } of importsOf(file, text, source)) {
      const fail = (rule) => violations.push(`${rel}: ${rule} (imports '${specifier}')`);
      if (specifier === '<computed>') fail('imports-are-static: no computed import()');
      if (/^@mondapac\/api(\/|$)/.test(specifier)) fail('panels never import apps/api');
      if (/^@mondapac\/(seller|admin|web)(\/|$)/.test(specifier) && (isUi || specifier !== self))
        fail(isUi ? 'packages/ui imports no app' : 'an app never imports another app');
      if (isUi && /^@mondapac\/panel-server(\/|$)/.test(specifier))
        fail('packages/ui imports no server-only package');
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (path.relative(pkgDir, target).startsWith('..'))
          fail('a relative import never leaves its package');
        else if (serverFile && importsClientModule(file, specifier))
          for (const name of values)
            if (!COMPONENT_NAME.test(name))
              fail(
                `server file takes '${name}' from a 'use client' module: only components and types; move it to a plain module`,
              );
      }
      if (specifier.startsWith('@mondapac/shared-kernel')) {
        if (specifier !== '@mondapac/shared-kernel')
          fail('the shared kernel is used through its main entry only');
        else if (names === null) fail('import the shared kernel by name, value types only');
        else
          for (const name of names)
            if (SERVER_ONLY_KERNEL_NAMES.has(name)) fail(`'${name}' is a server-side kernel type`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Panel boundaries: ${violations.length} violation(s)\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('Panel boundaries: ok');
