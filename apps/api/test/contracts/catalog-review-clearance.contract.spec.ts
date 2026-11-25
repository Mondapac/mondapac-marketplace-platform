import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The bypass guard of the edit rules (risk-based Offer approval, slice 2c): on a live Offer the
// domain applies a watched change (a changed description, handling off SEALED_ORIGINAL, a new tag)
// only with a ReviewClearance. Only application/offer-review-clearance.ts may build one, after the
// review policy or an admin approval; a new file that forges one fails here, so review sees it.

const SRC = path.resolve(__dirname, '../../src');
const ISSUER = 'modules/catalog/application/offer-review-clearance.ts';

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

/** A cast to the clearance type: the only way to build one outside the domain's declaration. */
const FORGES = /as\s+(unknown\s+as\s+)?ReviewClearance\b|\{\s*basis:\s*'(policy|approval)'\s*\}/;

describe('catalog review clearance (slice 2c bypass guard)', () => {
  it('is issued only by the clearance file', () => {
    const forging = files.filter(({ text }) => FORGES.test(text)).map((f) => f.file);
    expect(forging).toEqual([ISSUER]);
  });

  it('issues a policy clearance only for an empty reason list and an approval only when approved', () => {
    const text = files.find((f) => f.file === ISSUER)!.text;
    expect(text).toMatch(/reasons\.length === 0/);
    expect(text).toMatch(/status !== 'approved'/);
  });

  it('is passed by every seller command that writes a watched field of a live Offer', () => {
    for (const file of [
      'modules/catalog/application/use-cases/own-offer-edit.use-case.ts',
      'modules/catalog/application/use-cases/own-offer-set-handling.use-case.ts',
      'modules/catalog/application/use-cases/own-offer-add-tag.use-case.ts',
    ]) {
      const text = files.find((f) => f.file === file)!.text;
      expect([file, /clearanceFromPolicy\(reasons\)/.test(text)]).toEqual([file, true]);
      expect([file, /editReview\.reasons\(/.test(text)]).toEqual([file, true]);
    }
  });
});
