// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { TOPIC, published, read, revision } from './fixtures.ts';
import type { RevisionRead } from './types.ts';
import { VersionReview } from './version-review.tsx';

afterEach(cleanup);

const mount = (over: Partial<RevisionRead> = {}, locale = 'en-AU') =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <VersionReview
        read={{ ...read, ...over }}
        images={[]}
        categoryNames={{}}
        canDecide
        canTakeDown={false}
        csrfToken="csrf-1"
        nextHref={null}
      />
    </NextIntlClientProvider>,
  );
const card = () => within(screen.getByRole('heading', { name: 'Tags' }).closest('section')!);

describe('the Tags card of the version review', () => {
  it('sits after "Categories and tax" and before the variants', () => {
    mount();
    const headings = Array.from(document.querySelectorAll('h2')).map((h) => h.textContent);
    expect(headings.indexOf('Tags')).toBe(headings.indexOf('Categories and tax') + 1);
    expect(headings.indexOf('Variants')).toBe(headings.indexOf('Tags') + 1);
  });

  it('marks an added and a removed tag in words and signs, names an archived one, keeps one as is', () => {
    mount();
    const lines = card().getAllByRole('listitem');
    expect(lines.map((li) => li.textContent)).toEqual([
      'Ramadan (archived)',
      '+ PicnicAdded',
      '− EidRemoved',
    ]);
    expect(within(lines[1]!).getByText('Added')).toBeTruthy();
    expect(within(lines[2]!).getByText('Removed')).toBeTruthy();
    expect(lines[2]!.querySelector('.line-through')).toBeTruthy();
  });

  it('shows every tag of a first publication plainly, with no mark', () => {
    mount({ published: null });
    const lines = card().getAllByRole('listitem');
    expect(lines.map((li) => li.textContent)).toEqual(['Ramadan (archived)', 'Picnic']);
    expect(card().queryByText('Added')).toBeNull();
  });

  it('is hidden when neither side has tags', () => {
    mount({
      revision: { ...revision, topicIds: [] },
      published: { ...published, topicIds: [] },
    });
    expect(screen.queryByRole('heading', { name: 'Tags' })).toBeNull();
  });

  it('shows the card for a version that only removes every tag', () => {
    mount({ revision: { ...revision, topicIds: [] } });
    expect(
      card()
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['− EidRemoved', '− Ramadan (archived)Removed']);
  });

  it('names a tag in the panel language, then the default name, then any language', () => {
    mount({
      topicRefs: [
        {
          id: TOPIC(1),
          slug: 'eid',
          status: 'active',
          name: 'Eid',
          names: { ar: 'عيد', de: 'Fest' },
        },
        {
          id: TOPIC(2),
          slug: 'ramadan',
          status: 'active',
          name: 'Ramadan',
          names: { 'en-AU': 'R' },
        },
        {
          id: TOPIC(3),
          slug: 'barbecue',
          status: 'active',
          name: null,
          names: { ar: 'شواء' },
        },
      ],
    });
    const text = card()
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    // TOPIC(1) has no panel-language name: the default name wins over another language.
    // TOPIC(3) has neither: its first language shows.
    expect(text).toEqual(['R', '+ شواءAdded', '− EidRemoved']);
  });

  it('shows the id of a tag the read did not name', () => {
    mount({ topicRefs: [] });
    const text = card()
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(text).toContain(`+ ${TOPIC(3)}Added`);
  });

  it('labels the change reason "Tags" among the reasons of the header', () => {
    mount();
    const reasons = within(screen.getByRole('list', { name: 'What changed' }));
    expect(reasons.getByText('Tags')).toBeTruthy();
    expect(reasons.getByText('Name')).toBeTruthy();
  });
});
