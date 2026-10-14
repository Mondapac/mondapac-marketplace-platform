import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertTypeSeed, CertificationTypeSeedError } from './checked-in-type-seed';
import { loadFileTypeSeeds, TypeSeedFileError } from './file-type-seed';

const type = (over: Record<string, unknown> = {}) => ({
  code: 'qorvane',
  status: 'active',
  verificationMode: 'SELF_DECLARATION',
  requiresIssuerRegistry: false,
  requiresDocument: false,
  requiresExpiry: false,
  defaultBasis: 'SELLER_REQUIRED',
  autoApproveSelfDeclaration: false,
  badgeIconKey: 'seal',
  locales: { xx: { name: 'N', customerDescription: 'D', claimTerms: ['qorvane'] } },
  ...over,
});

function dirWith(name: string, body: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cert-seed-'));
  writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}

describe('loadFileTypeSeeds', () => {
  it('reads a well-formed file', () => {
    const seeds = loadFileTypeSeeds(dirWith('QQ.json', { market: 'QQ', types: [type()] }));
    expect(seeds.QQ?.map((t) => t.code)).toEqual(['qorvane']);
  });

  it('answers an empty set for a missing folder', () => {
    expect(loadFileTypeSeeds(path.join(tmpdir(), 'no-such-cert-seed-dir'))).toEqual({});
  });

  it('refuses a malformed file and a file named for another Market', () => {
    expect(() => loadFileTypeSeeds(dirWith('QQ.json', '{ not json'))).toThrow();
    expect(() => loadFileTypeSeeds(dirWith('QQ.json', { market: 'QQ', types: [{}] }))).toThrow(
      TypeSeedFileError,
    );
    expect(() => loadFileTypeSeeds(dirWith('QQ.json', { market: 'RR', types: [] }))).toThrow(
      TypeSeedFileError,
    );
  });

  it('refuses relaxed shapes from a file', () => {
    for (const over of [{ autoApproveSelfDeclaration: true }, { defaultBasis: 'NOT_APPLICABLE' }]) {
      expect(() =>
        loadFileTypeSeeds(dirWith('QQ.json', { market: 'QQ', types: [type(over)] })),
      ).toThrow(TypeSeedFileError);
    }
  });
});

describe('assertTypeSeed', () => {
  it('refuses an invalid code and a duplicate', () => {
    const t = loadFileTypeSeeds(dirWith('QQ.json', { market: 'QQ', types: [type()] })).QQ![0]!;
    expect(() => assertTypeSeed([t, t])).toThrow(CertificationTypeSeedError);
    expect(() => assertTypeSeed([{ ...t, code: 'Bad Code' as never }])).toThrow(
      CertificationTypeSeedError,
    );
  });
});
