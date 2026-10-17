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

/** Offer writes that change a claim input (design 5.4 "all tags" rows). */
const CLAIM_INPUT_WRITES =
  /\boffer\.(setHandling|edit|submit|recordAttestation|approve)\(|\bproduct\.approveRevision\(/;
/** The domain's tag writes. */
const TAG_WRITES = /\.(addTags|settleTags|setPendingPublishTags)\(/;

/**
 * Files that change a claim input but are known not to ask yet, each with the slice that brings
 * the ask. Keep this list short; an entry here is an open carry in the slice handoff.
 */
const DEFERRED: Readonly<Record<string, string>> = {
  // The re-ask at an Offer's approval and at a revision's publication (Hassan M1 part 1).
  'use-cases/offer-approve.use-case.ts': 'slice 11',
  'use-cases/product-revision-approve.use-case.ts': 'slice 11',
};

describe('catalog claim entry paths (design 5.1, 5.4)', () => {
  it('finds the known writers, so the scan is not vacuous', () => {
    const writers = files.filter(({ text }) => CLAIM_INPUT_WRITES.test(text)).map((f) => f.file);
    expect(writers).toEqual(
      expect.arrayContaining([
        'use-cases/own-offer-edit.use-case.ts',
        'use-cases/own-offer-set-handling.use-case.ts',
        'use-cases/own-offer-submit.use-case.ts',
        ...Object.keys(DEFERRED),
      ]),
    );
  });

  it('defers only files that still change a claim input without asking', () => {
    for (const file of Object.keys(DEFERRED)) {
      const found = files.find((f) => f.file === file);
      expect(found).toBeDefined();
      expect(CLAIM_INPUT_WRITES.test(found!.text)).toBe(true);
      expect(/\.settleTags\(/.test(found!.text)).toBe(false);
    }
  });

  it('settles the tags of every Offer write that changes a claim input', () => {
    const missing = files
      .filter(({ file, text }) => CLAIM_INPUT_WRITES.test(text) && !(file in DEFERRED))
      .filter(({ text }) => !/\.settleTags\(/.test(text))
      .map((f) => f.file);
    expect(missing).toEqual([]);
  });

  it('asks the evaluator through ClaimQueryBuilder wherever a tag is written', () => {
    const missing = files
      .filter(({ text }) => TAG_WRITES.test(text))
      .filter(
        ({ text }) =>
          !text.includes('ClaimEvaluator') ||
          !text.includes('ClaimQueryBuilder') ||
          !/askPrepared\(|askClaims\(/.test(text),
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
