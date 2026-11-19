import { visibleNavItems } from '@mondapac/ui';
import { describe, expect, it } from 'vitest';
import { adminNav } from '../nav.ts';
import { typeNames } from './format.ts';

describe('certificate type names', () => {
  it('prefers the full locale, then the language, then any name, then the code', () => {
    const map = typeNames(
      [
        { code: 'a', names: { 'en-AU': 'Aussie', en: 'English' } },
        { code: 'b', names: { en: 'English' } },
        { code: 'c', names: { fa: 'حلال' } },
        { code: 'd', names: {} },
      ],
      'en-AU',
    );
    expect([...map.entries()]).toEqual([
      ['a', 'Aussie'],
      ['b', 'English'],
      ['c', 'حلال'],
      ['d', 'd'],
    ]);
  });
});

describe('certificates menu item', () => {
  it('shows for a reviewer who may view the queue or the issuers, and for nobody else', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids(['certification.seller-certificate.view'])).toContain('certificates');
    expect(ids(['certification.type.view'])).not.toContain('certificates');
    expect(ids(['certification.issuer.view'])).toContain('certificates');
    expect(ids(['catalog.product.view'])).not.toContain('certificates');
  });
});
