import * as path from 'node:path';
import * as ts from 'typescript';

// Pricing design 6.5 ("contracts/ exports no Cost type"; Hassan, PR 7 review H1): no type that
// the pricing module exports to other modules (its barrel, index.ts) reaches `CostAmount`, through
// any property, parameter, return type, type argument, union member or base type. The
// dependency-cruiser rules keep the imports apart; this test checks the exported types themselves.
// A positive control walks the Cost use case, so a walker that finds nothing fails the suite.

const API_ROOT = path.resolve(__dirname, '../..');
const PRICING = path.join(API_ROOT, 'src/modules/pricing');
const BARREL = path.join(PRICING, 'index.ts');
const COST_USE_CASE = path.join(PRICING, 'application/use-cases/view-cost.use-case.ts');
const COST_DOMAIN = path.join(PRICING, 'domain/cost') + path.sep;
const SOURCE = path.join(API_ROOT, 'src') + path.sep;

function program(): ts.Program {
  const configPath = path.join(API_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, API_ROOT);
  return ts.createProgram({
    rootNames: [BARREL, COST_USE_CASE],
    options: { ...options, noEmit: true },
  });
}

/**
 * Whether the members of a type are walked: only types declared in this app's source, or
 * anonymous ones. A library or kernel type (Promise, Map, Temporal, Prisma) is walked only through
 * its type arguments, which keeps the walk small.
 */
function ownType(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declarations = symbol?.declarations ?? [];
  if (declarations.length === 0) return true;
  return declarations.some((declaration) =>
    path.resolve(declaration.getSourceFile().fileName).startsWith(SOURCE),
  );
}

function isCostSymbol(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((declaration) =>
    path.resolve(declaration.getSourceFile().fileName).startsWith(COST_DOMAIN),
  );
}

/** The exported names of `file` whose types reach a declaration in domain/cost/. */
function exportsReachingCost(built: ts.Program, file: string): string[] {
  const checker = built.getTypeChecker();
  const source = built.getSourceFile(file);
  if (source === undefined) throw new Error(`not in the program: ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`no module symbol: ${file}`);
  /** Memoised answers; a type being walked answers false to a cycle back to it. */
  const seen = new Map<ts.Type, boolean>();

  const reaches = (type: ts.Type, depth: number): boolean => {
    const known = seen.get(type);
    if (known !== undefined) return known;
    if (depth > 10) return false;
    seen.set(type, false);
    const found = walk(type, depth);
    seen.set(type, found);
    return found;
  };

  const walk = (type: ts.Type, depth: number): boolean => {
    if (isCostSymbol(type.getSymbol()) || isCostSymbol(type.aliasSymbol)) return true;
    const parts: ts.Type[] = [
      ...(type.isUnionOrIntersection() ? type.types : []),
      ...(type.aliasTypeArguments ?? []),
      ...((type.flags & ts.TypeFlags.Object) !== 0 &&
      ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
        ? checker.getTypeArguments(type as ts.TypeReference)
        : []),
      ...(type.isClassOrInterface() ? (checker.getBaseTypes(type) ?? []) : []),
    ];
    if (ownType(type)) {
      for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
        parts.push(checker.getReturnTypeOfSignature(signature));
        for (const parameter of signature.getParameters()) {
          parts.push(checker.getTypeOfSymbol(parameter));
        }
      }
      for (const property of type.getProperties()) {
        if (property.getName().startsWith('__@')) continue; // symbol-keyed members
        parts.push(checker.getTypeOfSymbol(property));
      }
      const index = type.getStringIndexType() ?? type.getNumberIndexType();
      if (index !== undefined) parts.push(index);
    }
    return parts.some((part) => reaches(part, depth + 1));
  };

  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((exported) => {
      const symbol =
        (exported.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(exported)
          : exported;
      if (isCostSymbol(symbol)) return true;
      const types = [checker.getDeclaredTypeOfSymbol(symbol)];
      if ((symbol.flags & ts.SymbolFlags.Value) !== 0) {
        types.push(checker.getTypeOfSymbol(symbol));
      }
      return types.some((type) => reaches(type, 0));
    })
    .map((exported) => exported.getName())
    .sort();
}

describe('pricing exports no Cost type (pricing design 6.5)', () => {
  const built = program();

  it('no export of the pricing barrel reaches CostAmount', () => {
    expect(exportsReachingCost(built, BARREL)).toEqual([]);
  });

  it('positive control: the Cost use case does reach it', () => {
    expect(exportsReachingCost(built, COST_USE_CASE)).toEqual(
      expect.arrayContaining(['OfferCostsView', 'VariantCostView']),
    );
  });
});
