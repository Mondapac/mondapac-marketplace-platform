// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';
import { typeNames } from './format.ts';
import { CertificateQueue } from './queue.tsx';
import type { QueueRow } from './types.ts';

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  certificateId: '0190a000-0000-7000-8000-0000000000c1',
  version: 3,
  submissionId: '0190a000-0000-7000-8000-0000000000d1',
  submissionNo: 2,
  kind: 'resubmission',
  typeCode: 'halal',
  sellerId: '0190a000-0000-7000-8000-000000000300',
  storeName: 'Logan Road Grocer',
  issuerName: 'Halal Certification Authority',
  submittedAt: '2026-10-14T01:00:00.000Z',
  ...over,
});

function mount(
  rows: QueueRow[],
  names: ReadonlyMap<string, string> = new Map([['halal', 'Halal']]),
  morePages = false,
) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <CertificateQueue rows={rows} typeNames={names} morePages={morePages} />
    </NextIntlClientProvider>,
  );
}

describe('admin certificate review queue', () => {
  afterEach(cleanup);

  it('shows a submission with seller, type name, kind, issuer and submission number', () => {
    mount([row()]);
    expect(
      screen.getByRole('link', { name: 'Logan Road Grocer, seller 00000300' }).getAttribute('href'),
    ).toBe('/sellers/0190a000-0000-7000-8000-000000000300');
    expect(screen.getByText('Halal')).toBeTruthy();
    expect(screen.getByText('Resubmitted')).toBeTruthy();
    expect(screen.getByText('Submission 2')).toBeTruthy();
    expect(screen.getByText('Halal Certification Authority')).toBeTruthy();
  });

  it('names a seller that is not approved yet, and keeps the type code without a name', () => {
    mount([row({ storeName: null, typeCode: 'kosher', issuerName: null, kind: 'renewal' })]);
    expect(screen.getByText('Not yet approved')).toBeTruthy();
    expect(screen.getByText('kosher')).toBeTruthy();
    expect(screen.getByText('Not named')).toBeTruthy();
    expect(screen.getByText('Renewal')).toBeTruthy();
  });

  it('tells an empty queue from an empty page of a longer one', () => {
    mount([]);
    expect(screen.getByText('No certificates are waiting for a decision.')).toBeTruthy();
    cleanup();
    mount([], new Map(), true);
    expect(screen.getByText('Nothing on this page. Go back to the first page.')).toBeTruthy();
  });

  it('renders seller-entered text as plain text', () => {
    mount([row({ storeName: '<img src=x onerror=alert(1)>' })]);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

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
  it('shows for a reviewer who may view the queue, and for nobody else', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids(['certification.seller-certificate.view'])).toContain('certificates');
    expect(ids(['certification.type.view'])).not.toContain('certificates');
    expect(ids(['catalog.product.view'])).not.toContain('certificates');
  });
});
