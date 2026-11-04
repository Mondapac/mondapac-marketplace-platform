import { describe, expect, it } from 'vitest';
import { GET } from '../app/.well-known/assetlinks.json/route.ts';
import { TWA_PACKAGE, assetLinks } from '../src/pwa/asset-links.ts';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(
  ':',
);

describe('Digital Asset Links', () => {
  it('trusts no app while no fingerprint is set', () => {
    expect(assetLinks(undefined)).toEqual([]);
    expect(assetLinks(' , ')).toEqual([]);
  });

  it('lists the package with every fingerprint, upper-cased', () => {
    const [s] = assetLinks(`${FP.toLowerCase()}, ${FP}`) as Array<{
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }>;
    expect(s?.relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(s?.target.namespace).toBe('android_app');
    expect(s?.target.package_name).toBe(TWA_PACKAGE);
    expect(s?.target.sha256_cert_fingerprints).toEqual([FP, FP]);
  });

  it('refuses a malformed fingerprint', () => {
    expect(() => assetLinks('AB:CD')).toThrow(/malformed/);
  });

  it('serves JSON from the route', async () => {
    const res = GET();
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual([]);
  });
});
