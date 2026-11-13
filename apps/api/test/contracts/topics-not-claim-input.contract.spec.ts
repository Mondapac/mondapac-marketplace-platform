import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The boundary of product tags (ADR-0028; ADR-0019 R1): a topic is a shopping theme and carries no
// certification meaning. It is never an input to `evaluateClaim`, never a certification tag, and
// the certification module does not import it. These checks read the sources, so a change that
// feeds a topic into a claim fails here and the review sees it.

const SRC = path.resolve(__dirname, '../../src');
const CATALOG = path.join(SRC, 'modules/catalog');

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}
const read = (dir: string) =>
  sources(dir).map((file) => ({
    file: path.relative(SRC, file),
    text: readFileSync(file, 'utf8'),
  }));

/** A topic word as an import path or an identifier, in any case. */
const TOPIC = /topic/i;

describe('topics carry no certification meaning', () => {
  it('finds the sources it scans, so the checks are not vacuous', () => {
    expect(read(path.join(SRC, 'modules/certification')).length).toBeGreaterThan(20);
    expect(read(path.join(CATALOG, 'application/tags')).map((f) => path.basename(f.file))).toEqual(
      expect.arrayContaining(['claim-query-builder.ts', 'ask-claims.ts']),
    );
    expect(read(path.join(CATALOG, 'domain')).some((f) => f.file.endsWith('domain/topic.ts'))).toBe(
      true,
    );
  });

  it('keeps the certification module free of topics', () => {
    const offenders = read(path.join(SRC, 'modules/certification')).filter(({ text }) =>
      TOPIC.test(text),
    );
    expect(offenders.map((f) => f.file)).toEqual([]);
  });

  it('keeps topics out of the claim query and the claim path of catalog', () => {
    const claimFiles = [
      ...read(path.join(CATALOG, 'application/tags')),
      ...read(CATALOG).filter(({ file }) =>
        /(^|\/)(offer-tag|offer-handling|offer)\.ts$|claim-evaluator|evaluate-claim/.test(file),
      ),
    ];
    expect(claimFiles.length).toBeGreaterThan(4);
    expect(claimFiles.filter(({ text }) => TOPIC.test(text)).map((f) => f.file)).toEqual([]);
  });

  it('lets no module but catalog import a topic file, and the AI code none at all', () => {
    const outside = read(SRC).filter(({ file }) => !file.startsWith('modules/catalog/'));
    const importing = outside.filter(({ text }) =>
      /from\s+['"][^'"]*catalog\/[^'"]*topic[^'"]*['"]/i.test(text),
    );
    // Only the app wiring (and tests, not scanned here) may name the catalog's topic ports.
    expect(importing.map((f) => f.file)).toEqual([]);
    expect(read(path.join(SRC, 'platform/ai')).filter(({ text }) => TOPIC.test(text))).toEqual([]);
  });

  it('reads the tag of an Offer from its own table, never from the product topics', () => {
    const offerTag = readFileSync(path.join(CATALOG, 'domain/offer-tag.ts'), 'utf8');
    expect(offerTag).not.toMatch(/topicIds|TopicState|TopicReader/);
  });
});
