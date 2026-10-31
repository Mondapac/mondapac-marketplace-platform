import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsHub, type SettingsHubGroup } from './settings-hub.tsx';
import { SettingsHubHeader } from './settings-hub-header.tsx';

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const labels = { viewOnly: 'View only' };
const label = (key: string) => key.toUpperCase();

const groups: readonly SettingsHubGroup[] = [
  {
    group: { id: 'store', labelKey: 'store', icon: 'store' },
    links: [
      { link: { id: 'profile', labelKey: 'profile', href: '/settings/profile' }, viewOnly: false },
      { link: { id: 'stock', labelKey: 'stock', href: '/settings/stock' }, viewOnly: true },
    ],
  },
  {
    group: { id: 'money', labelKey: 'money', icon: 'wallet' },
    links: [
      { link: { id: 'payout', labelKey: 'payout', href: '/settings/payout' }, viewOnly: false },
    ],
  },
];

describe('SettingsHub', () => {
  it('draws a card per group and a link per page, each link ending with a chevron', () => {
    const out = html(<SettingsHub groups={groups} label={label} labels={labels} />);
    expect(out.match(/<section/g)).toHaveLength(2);
    expect(out.match(/<a /g)).toHaveLength(3);
    // One chevron-right per link; it flips in a right-to-left page.
    expect(out.match(/rtl:-scale-x-100/g)).toHaveLength(3);
    expect(out).toContain('href="/settings/stock"');
    expect(out).toContain('>STOCK</span>');
  });

  it('marks only the view-only page with the chip', () => {
    const out = html(<SettingsHub groups={groups} label={label} labels={labels} />);
    expect(out.match(/View only/g)).toHaveLength(1);
  });

  it('puts one card on a phone and never more than two to a row at any width', () => {
    const out = html(<SettingsHub groups={groups} label={label} labels={labels} />);
    expect(out).toContain('grid-cols-1');
    expect(out).toContain('sm:grid-cols-2');
    expect(out).not.toMatch(/grid-cols-3/);
  });
});

describe('SettingsHubHeader', () => {
  it('names the page and says what it is for; the Search button needs the panel tools', () => {
    const out = html(<SettingsHubHeader title="Settings" description="Set up the store." />);
    expect(out).toContain('<h1');
    expect(out).toContain('Settings');
    expect(out).toContain('Set up the store.');
    expect(out).not.toContain('<button');
  });
});
