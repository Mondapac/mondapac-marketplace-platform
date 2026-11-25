import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import {
  Offer,
  type OfferState,
  type ReviewClearance,
} from '../../src/modules/catalog/domain/offer';
import {
  clearanceFromPolicy,
  policyVerdict,
  type ReviewPolicyVerdict,
} from '../../src/modules/catalog/application/offer-review-clearance';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';

// The bypass guard of the edit rules (risk-based Offer approval, slice 2c; Hassan S1 on PR #1350):
// on a live Offer the domain applies a watched change (a changed description, handling off
// SEALED_ORIGINAL, a new tag) only with a ReviewClearance that domain/review-clearance.ts issued
// for that Offer (a run-time brand, so a cast or an object literal never passes). Who may reach
// the issuing functions is an import allow-list, read from the syntax tree of every non-test source
// file: a new importer fails here, so review sees it.

const SRC = path.resolve(__dirname, '../../src');
const CATALOG = 'modules/catalog';
const DOMAIN_ISSUER = `${CATALOG}/domain/review-clearance.ts`;
const APP_ISSUER = `${CATALOG}/application/offer-review-clearance.ts`;
const SELLER_COMMANDS = [
  `${CATALOG}/application/use-cases/own-offer-add-tag.use-case.ts`,
  `${CATALOG}/application/use-cases/own-offer-edit.use-case.ts`,
  `${CATALOG}/application/use-cases/own-offer-set-handling.use-case.ts`,
];
const APPROVAL = `${CATALOG}/application/use-cases/admin-offer-change-approve.use-case.ts`;

/** Every value a file may import from one of the two issuing modules, and who may import it. */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  [DOMAIN_ISSUER]: {
    issueReviewClearance: [APP_ISSUER],
    isIssuedClearance: [`${CATALOG}/domain/offer.ts`],
  },
  [APP_ISSUER]: {
    policyVerdict: [`${CATALOG}/application/offer-edit-review.ts`],
    clearanceFromPolicy: SELLER_COMMANDS,
    clearanceFromApproval: [APPROVAL],
  },
};
const ISSUING_NAMES = Object.values(ALLOWED).flatMap((names) => Object.keys(names));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

const files = sources(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/** The source-relative file a relative specifier names, or null for a package. */
function resolved(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return target.endsWith('.ts') ? target : `${target}.ts`;
}

interface Reach {
  readonly file: string;
  readonly module: string;
  /** A value name, `*` for a namespace import or a re-export of everything, `dynamic` for import(). */
  readonly name: string;
}

/** Every value reach of a file into one of the issuing modules (type-only imports excluded). */
function reachesOf(file: string, text: string): Reach[] {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Reach[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = resolved(file, node.moduleSpecifier.text);
      if (module !== null && module in ALLOWED) {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          if (clause !== undefined && !clause.isTypeOnly) {
            if (clause.name !== undefined) found.push({ file, module, name: 'default' });
            const bindings = clause.namedBindings;
            if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
              found.push({ file, module, name: '*' });
            } else if (bindings !== undefined) {
              for (const element of bindings.elements) {
                if (element.isTypeOnly) continue;
                found.push({ file, module, name: (element.propertyName ?? element.name).text });
              }
            }
          }
        } else if (!node.isTypeOnly) {
          const clause = node.exportClause;
          if (clause === undefined || ts.isNamespaceExport(clause)) {
            found.push({ file, module, name: '*' });
          } else {
            for (const element of clause.elements) {
              if (element.isTypeOnly) continue;
              found.push({ file, module, name: (element.propertyName ?? element.name).text });
            }
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      const module = resolved(file, node.arguments[0].text);
      if (module !== null && module in ALLOWED) found.push({ file, module, name: 'dynamic' });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const reaches = files.flatMap(({ file, text }) => reachesOf(file, text));

describe('catalog review clearance (slice 2c bypass guard)', () => {
  it('lets only the allow-listed files import the issuing functions', () => {
    const refused = reaches
      .filter(({ file, module, name }) => !(ALLOWED[module]![name] ?? []).includes(file))
      .map(({ file, module, name }) => `${file} -> ${module}#${name}`);
    expect(refused).toEqual([]);
  });

  it('finds every allow-listed import, so a walker that finds nothing fails', () => {
    const expected = Object.entries(ALLOWED).flatMap(([module, names]) =>
      Object.entries(names).flatMap(([name, importers]) =>
        importers.map((file) => `${file} -> ${module}#${name}`),
      ),
    );
    const seen = reaches.map(({ file, module, name }) => `${file} -> ${module}#${name}`);
    expect([...new Set(seen)].sort()).toEqual([...expected].sort());
  });

  it('never names an issuing function outside its module and its allow-listed importers', () => {
    const named = files.flatMap(({ file, text }) =>
      ISSUING_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(text))
        .filter((name) => {
          const [module, importers] = Object.entries(ALLOWED).find(([, names]) => name in names)!;
          return file !== module && !importers[name]!.includes(file);
        })
        .map((name) => `${file}: ${name}`),
    );
    expect(named).toEqual([]);
  });

  it('is passed by every seller command that writes a watched field of a live Offer', () => {
    for (const file of SELLER_COMMANDS) {
      const text = files.find((f) => f.file === file)!.text;
      expect([file, /clearanceFromPolicy\(verdict\)/.test(text)]).toEqual([file, true]);
      expect([file, /editReview\.verdict\(context, subject,/.test(text)]).toEqual([file, true]);
      expect([file, /const subject = \{ offerId, sellerId/.test(text)]).toEqual([file, true]);
    }
  });

  describe.each(['AU', 'ZZ'] as const)('at run time, in market %s', (code) => {
    const offerId = `offer-${code}` as Id<'Offer'>;
    const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');
    const live = (): Offer =>
      Offer.restore({
        id: offerId,
        marketId: code as MarketId,
        sellerId: 's1' as Id<'Seller'>,
        productId: 'p1' as Id<'Product'>,
        sellerSku: 'SKU-1',
        conditionCode: 'new',
        description: { en: 'Sealed' },
        handling: 'SEALED_ORIGINAL',
        attestationRecordedAt: null,
        attestationAccountId: null,
        status: 'published',
        offSaleCauses: [],
        listed: true,
        submittedAt: T0,
        firstPublishedAt: T0,
        deletedAt: null,
        version: 3,
        createdAt: T0,
      } satisfies OfferState);
    const edit = (offer: Offer, review: ReviewClearance | undefined) =>
      offer.edit({
        sellerSku: 'SKU-1',
        conditionCode: 'new',
        description: { en: 'Changed' },
        now: T0,
        ...(review === undefined ? {} : { review }),
      });
    const clean = {
      mode: 'risk-based',
      certificateBadges: 'review',
      emergencyStop: false,
      sensitiveCategory: false,
      addedBadgeTypes: [],
    } as const;

    it('refuses every forge the regex test of PR #1350 let through', () => {
      const forges: unknown[] = [
        { basis: 'policy' },
        { basis: 'policy' as const },
        Object.freeze({ basis: 'approval', offerId }),
        JSON.parse(`{"basis":"policy","offerId":"${offerId}"}`) as unknown,
      ];
      for (const forged of forges) {
        expect(() => edit(live(), forged as ReviewClearance)).toThrow('review clearance');
      }
    });

    it('issues a policy clearance only from a sealed verdict with no reason, for its Offer', () => {
      const typed: ReviewPolicyVerdict = { offerId, reasons: [] };
      expect(clearanceFromPolicy(typed)).toBeUndefined();
      expect(clearanceFromPolicy(null)).toBeUndefined();
      const held = policyVerdict(offerId, { ...clean, mode: 'all', newDescription: { en: 'New' } });
      expect(held.reasons.length).toBeGreaterThan(0);
      expect(clearanceFromPolicy(held)).toBeUndefined();
      const passed = clearanceFromPolicy(policyVerdict(offerId, clean));
      expect(edit(live(), passed).ok).toBe(true);
      const other = clearanceFromPolicy(policyVerdict('another' as Id<'Offer'>, clean));
      expect(() => edit(live(), other)).toThrow('review clearance');
    });
  });
});
