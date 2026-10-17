import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * ADR-0031 decision 4, the unit rule: a file under an `infrastructure/placeholders/` folder is a
 * TypeScript file whose every class carries `@FailClosedPlaceholder('<port>')` and whose only
 * exported values are those classes. Read from the syntax tree, so comments, `export default`,
 * class expressions and object-literal stand-ins cannot slip past (Hassan S3).
 */
const SRC = join(__dirname, '..', 'src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function decoratedAsPlaceholder(node: ts.ClassLikeDeclaration): boolean {
  return (ts.getDecorators(node) ?? []).some((decorator) => {
    const call = decorator.expression;
    return (
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === 'FailClosedPlaceholder' &&
      call.arguments.length === 1 &&
      ts.isStringLiteral(call.arguments[0]!)
    );
  });
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** The problems of one placeholders file, as `<name>: <problem>` lines. */
export function placeholderFileProblems(name: string, text: string): string[] {
  if (!name.endsWith('.ts') || name.endsWith('.d.ts')) return [`${name}: not a TypeScript file`];
  if (name.endsWith('.spec.ts')) return [];
  const problems: string[] = [];
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      !decoratedAsPlaceholder(node)
    ) {
      problems.push(
        `${name}: class ${node.name?.text ?? '(anonymous)'} has no @FailClosedPlaceholder`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) problems.push(`${name}: export default`);
    else if (
      isExported(statement) &&
      !ts.isClassDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement)
    ) {
      problems.push(`${name}: exports a value that is not a placeholder class`);
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      problems.push(`${name}: re-exports`);
    }
  }
  return problems;
}

describe('ADR-0031 decision 4: files under infrastructure/placeholders/', () => {
  it('hold only placeholder classes carrying @FailClosedPlaceholder', () => {
    const files = filesUnder(SRC).filter((f) =>
      f.split(/[\\/]/).join('/').includes('/infrastructure/placeholders/'),
    );
    expect(
      files.flatMap((f) => placeholderFileProblems(relative(SRC, f), readFileSync(f, 'utf8'))),
    ).toEqual([]);
  });

  it('accepts a decorated class', () => {
    const text = `@FailClosedPlaceholder('sellers.allowedProductTypesOf')\nexport class UnavailableReader {}\nexport type X = 1;\n`;
    expect(placeholderFileProblems('a.ts', text)).toEqual([]);
  });

  it.each([
    ['no decorator', 'export class R {}'],
    ['a decorator in a comment', "// @FailClosedPlaceholder('a.b')\nexport class R {}"],
    [
      'a second class without a blank line',
      "@FailClosedPlaceholder('a.b')\nexport class A {}\nexport class B {}",
    ],
    ['export default', "@FailClosedPlaceholder('a.b')\nclass A {}\nexport default A;"],
    ['a class expression', 'export const R = class {};'],
    ['an object-literal stand-in', 'export const reader = { allowedFor: () => null };'],
    ['a factory function', 'export function reader() { return null; }'],
    ['a re-export', "export { R } from './r';"],
  ])('refuses %s', (_case, text) => {
    expect(placeholderFileProblems('a.ts', text)).not.toEqual([]);
  });

  it('refuses a file that is not TypeScript', () => {
    expect(placeholderFileProblems('a.js', '')).toEqual(['a.js: not a TypeScript file']);
  });
});
