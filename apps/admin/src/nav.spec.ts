import { visibleNavItems } from '@mondapac/ui';
import { describe, expect, it } from 'vitest';
import { adminNav } from './nav.ts';

const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);

describe('admin nav: Content', () => {
  it('is there for storefront.slide.read, with the layout icon', () => {
    expect(ids(['storefront.slide.read'])).toContain('content');
    const item = adminNav.items.find((entry) => entry.id === 'content');
    expect(item).toMatchObject({ icon: 'layout', href: '/content', labelKey: 'nav.content' });
  });

  it('is hidden without it, also for the other slide keys', () => {
    expect(ids([])).not.toContain('content');
    expect(ids(['storefront.slide.edit', 'storefront.slide.publish'])).not.toContain('content');
  });
});
