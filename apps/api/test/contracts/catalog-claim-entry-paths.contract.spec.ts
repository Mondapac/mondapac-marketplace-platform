import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The entry-path check of catalog design 5.1 and 5.4 (CERT-21; AC 11, 33): every catalog file that
// changes what a claim is judged on (an Offer's handling, attestation or content, its submit, a
// product's submitted revision) or that writes a tag goes through `ClaimQueryBuilder` and the
// `ClaimEvaluator` port, and settles the Offer's tags in the domain on decisions of the same
// request. A new writer that skips the ask fails here, so the review sees it. Tags are written
// only by the Offer aggregate; no file outside `domain/` touches a tag status directly.

const APPLICATION = path.resolve(__dirname, '../../src/modules/catalog/application');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

const files = sources(APPLICATION).map((file) => ({
  file: path.relative(APPLICATION, file),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Offer writes that change a claim input (design 5.4 "all tags" rows), and the writes that move a
 * product's published pointer (a revision submit that may publish at once, an approval).
 */
const CLAIM_INPUT_WRITES =
  /\boffer\.(setHandling|edit|submit|recordAttestation|approve)\(|\bproduct\.(approveRevision|submitRevision)\(/;
/** The domain's tag writes from fresh decisions. */
const TAG_WRITES = /\.(addTags|settleTags|setPendingPublishTags|settlePublish)\(/;
/** A claim-bearing file settles its tags on decisions, or (M1) marks them for the fan-out. */
const SETTLES = /\.(settleTags|settlePublish)\(|\bclaims\.settle\(|markProductForReevaluation\(/;

/**
 * Files that change a claim input but are known not to ask yet, each with the slice that brings
 * the ask. Keep this list short; an entry here is an open carry in the slice handoff. Empty since
 * slice 11 (the approval and publication re-asks).
 */
const DEFERRED: Readonly<Record<string, string>> = {};

describe('catalog claim entry paths (design 5.1, 5.4)', () => {
  it('finds the known writers, so the scan is not vacuous', () => {
    const writers = files.filter(({ text }) => CLAIM_INPUT_WRITES.test(text)).map((f) => f.file);
    expect(writers).toEqual(
      expect.arrayContaining([
        'use-cases/own-offer-edit.use-case.ts',
        'use-cases/own-offer-set-handling.use-case.ts',
        'use-cases/own-offer-submit.use-case.ts',
        'use-cases/offer-approve.use-case.ts',
        'use-cases/product-revision-approve.use-case.ts',
        'revisions/submit-product.service.ts',
      ]),
    );
  });

  it('defers only files that still change a claim input without asking', () => {
    for (const file of Object.keys(DEFERRED)) {
      const found = files.find((f) => f.file === file);
      expect(found).toBeDefined();
      expect(CLAIM_INPUT_WRITES.test(found!.text)).toBe(true);
      expect(SETTLES.test(found!.text)).toBe(false);
    }
  });

  it('settles the tags of every Offer write that changes a claim input', () => {
    const missing = files
      .filter(({ file, text }) => CLAIM_INPUT_WRITES.test(text) && !(file in DEFERRED))
      .filter(({ text }) => !SETTLES.test(text))
      .map((f) => f.file);
    expect(missing).toEqual([]);
  });

  it('re-asks at both approvals and at a publish at once (Hassan M1 condition, slice 11)', () => {
    const text = (file: string) => files.find((f) => f.file === file)!.text;
    expect(text('use-cases/offer-approve.use-case.ts')).toMatch(/\.settleTags\(/);
    expect(text('use-cases/offer-approve.use-case.ts')).toMatch(/factsInUnit\(/);
    expect(text('use-cases/product-revision-approve.use-case.ts')).toMatch(/\.settlePublish\(/);
    // The submit service hands the outcome to the seller's claim steps, which settle a publish.
    expect(text('revisions/submit-product.service.ts')).toMatch(/claims\.settle\(/);
    expect(text('use-cases/own-product-submit.use-case.ts')).toMatch(/\.settlePublish\(/);
  });

  it('marks rechecking only together with a fan-out request (rule M1) or a re-ask (slice 12)', () => {
    const marking = files.filter(({ text }) => /\.markRechecking\(/.test(text));
    expect(marking.map((f) => f.file).sort()).toEqual([
      'tags/publish-fan-out.ts',
      'tags/reask-offers.ts',
    ]);
    const text = (file: string) => marking.find((f) => f.file === file)!.text;
    expect(text('tags/publish-fan-out.ts')).toMatch(/requestForPublish\(/);
    // The certification-event and reconciliation re-ask (design 5.5, 5.6) marks, then asks and
    // settles the same Offers itself.
    expect(text('tags/reask-offers.ts')).toMatch(/askClaimsMany\(/);
    expect(text('tags/reask-offers.ts')).toMatch(/\.settleTags\(/);
    // Every PLATFORM publish (the submit service is the only publish of PLATFORM content).
    expect(files.find((f) => f.file === 'revisions/submit-product.service.ts')!.text).toMatch(
      /markProductForReevaluation\(/,
    );
  });

  it('serialises tag writes against publication through the product lock (slice 11)', () => {
    const claims = files.find((f) => f.file === 'tags/offer-claims.ts')!.text;
    expect(claims).toMatch(/lockProduct\(/);
    // Every unit that writes a tag on the published facts goes through factsInUnit.
    const publishedWriters = files
      .filter(({ text }) => /\.(addTags|settleTags)\(/.test(text))
      .filter(({ text }) => !/factsInUnit\(/.test(text))
      .map((f) => f.file);
    expect(publishedWriters).toEqual([]);
  });

  it('asks the evaluator through ClaimQueryBuilder wherever a tag is written', () => {
    const missing = files
      .filter(({ text }) => TAG_WRITES.test(text))
      .filter(
        ({ text }) =>
          !text.includes('ClaimEvaluator') ||
          !text.includes('ClaimQueryBuilder') ||
          !/askPrepared\(|askClaims\(|askClaimsMany\(/.test(text),
      )
      .map((f) => f.file);
    expect(missing).toEqual([]);
  });

  it('passes the product submit its claim steps', () => {
    const submit = files.find((f) => f.file === 'use-cases/own-product-submit.use-case.ts')!;
    expect(submit.text).toMatch(/claims: this\.#claims\(/);
    expect(submit.text).toMatch(/setPendingPublishTags\(/);
  });

  it('never sets a tag status, badge or copy outside the domain', () => {
    const offenders = files
      .filter(({ text }) =>
        /\bstatus:\s*'(active|suspended|rechecking|pending-publish)'/.test(text),
      )
      .filter(({ text }) => /OfferTagState|tags\.push|#tags/.test(text))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});
