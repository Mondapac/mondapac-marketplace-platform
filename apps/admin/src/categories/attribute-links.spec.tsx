// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { AttributeLinksTab } from './attribute-links-tab.tsx';
import { CategoryDetails } from './category-details.tsx';
import type { LinksBody } from './attribute-links-model.ts';
import type { CategoryRow, DetailBody } from './types.ts';

// The "Attribute links" tab of a category (categories C8, inside attributes A4): the read view with
// "Inherited from {parent}", the editor with its feature set choice and ordered filter list, the
// version sent with a save, the refusals, and who sees the tab.

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

/** jsdom has no modal dialogs; the stub only marks the dialog open. */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

const category: CategoryRow = {
  id: id(2),
  parentId: id(1),
  slug: 'rice',
  status: 'active',
  mergedIntoId: null,
  names: [{ locale: 'en', name: 'Rice' }],
  depth: 1,
  position: 0,
  version: 1,
  counts: { liveProducts: 0, liveProductsDirect: 0, offers: 0 },
};
const body: DetailBody = {
  category,
  path: [
    { id: id(1), slug: 'pantry', name: 'Pantry' },
    { id: id(2), slug: 'rice', name: 'Rice' },
  ],
  requiredLocales: ['en'],
  missingLocales: [],
  revisions: [],
  complete: true,
  actions: {},
  details: {
    texts: [],
    seo: { title: null, description: null, noindex: false },
    showInMenu: true,
    imageId: null,
    hiddenById: null,
  },
} as unknown as DetailBody;

const names = (en: string) => ({ en });
const inheritedLinks: LinksBody = {
  categoryId: id(2),
  own: null,
  effective: {
    featureSet: {
      id: id(50),
      code: 'pantry',
      names: names('Pantry goods'),
      fromCategoryId: id(1),
      inherited: true,
    },
    filters: [
      {
        code: 'origin',
        fromCategoryId: id(1),
        inherited: true,
        names: names('Origin'),
        dataType: 'select',
        status: 'active',
      },
    ],
  },
};
const ownLinks: LinksBody = {
  categoryId: id(2),
  own: { featureSetId: id(51), filters: ['grain', 'organic'], revisionNo: 2, version: 7 },
  effective: {
    featureSet: {
      id: id(51),
      code: 'rice-set',
      names: names('Rice'),
      fromCategoryId: id(2),
      inherited: false,
    },
    filters: [
      {
        code: 'origin',
        fromCategoryId: id(1),
        inherited: true,
        names: names('Origin'),
        dataType: 'select',
        status: 'active',
      },
      {
        code: 'grain',
        fromCategoryId: id(2),
        inherited: false,
        names: names('Grain'),
        dataType: 'select',
        status: 'active',
      },
      {
        code: 'organic',
        fromCategoryId: id(2),
        inherited: false,
        names: names('Organic'),
        dataType: 'boolean',
        status: 'active',
      },
    ],
  },
};
const featureSets = {
  items: [
    { id: id(50), code: 'pantry', status: 'active', names: names('Pantry goods') },
    { id: id(51), code: 'rice-set', status: 'active', names: names('Rice') },
    { id: id(52), code: 'old', status: 'archived', names: names('Old') },
  ],
  truncated: false,
};
const attributes = {
  items: [
    { id: id(60), code: 'origin', dataType: 'select', status: 'active', names: names('Origin') },
    { id: id(61), code: 'grain', dataType: 'select', status: 'active', names: names('Grain') },
    { id: id(62), code: 'organic', dataType: 'boolean', status: 'active', names: names('Organic') },
    { id: id(63), code: 'notes', dataType: 'text', status: 'active', names: names('Notes') },
    { id: id(64), code: 'size', dataType: 'decimal', status: 'active', names: names('Size') },
  ],
  nextAfterId: null,
};

function mount(canEdit: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AttributeLinksTab body={body} canEdit={canEdit} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
}

/** Answers the reads of the tab by route; every other call is the test's own. */
function serve(links: LinksBody, put: ApiResult<unknown> = ok({})) {
  call.mockImplementation((method, path) => {
    if (method === 'PUT') return Promise.resolve(put);
    if (method === 'GET' && path.includes('/attribute-links')) return Promise.resolve(ok(links));
    if (method === 'GET' && path.startsWith('catalog/admin/feature-sets')) {
      return Promise.resolve(ok(featureSets));
    }
    if (method === 'GET' && path.startsWith('catalog/admin/attributes')) {
      return Promise.resolve(ok(attributes));
    }
    return Promise.resolve(fail(500, 'unexpected'));
  });
}

describe('Attribute links tab', () => {
  beforeEach(() => {
    call.mockReset();
    stubDialog();
  });
  afterEach(cleanup);

  it('shows an inherited feature set and filters with where they come from', async () => {
    serve(inheritedLinks);
    mount(false);
    expect(await screen.findByText('Pantry goods')).toBeTruthy();
    expect(screen.getAllByText('Inherited from Pantry')).toHaveLength(2);
    expect(screen.getByText('Origin')).toBeTruthy();
    expect(screen.getByText('You can see the attribute links but not change them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit attribute links' })).toBeNull();
    expect(call.mock.calls[0]?.[1]).toBe(`catalog/admin/categories/${id(2)}/attribute-links`);
  });

  it('says so when the category has no feature set and no filters', async () => {
    serve({ categoryId: id(2), own: null, effective: { featureSet: null, filters: [] } });
    mount(true);
    expect(
      await screen.findByText('No feature set. Products here use the core details only.'),
    ).toBeTruthy();
    expect(screen.getByText(/No filters/)).toBeTruthy();
  });

  it('shows an error with a retry', async () => {
    call.mockResolvedValueOnce(fail(503, 'access.unavailable'));
    serve(inheritedLinks);
    mount(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Pantry goods')).toBeTruthy();
  });

  it('edits the own filters in order and saves with the version read', async () => {
    serve(ownLinks);
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    const own = await screen.findByRole('list', { name: 'Filters of this category' });
    expect(within(own).getAllByRole('listitem')).toHaveLength(2);
    // Move "Organic" up, remove "Grain", add "Size".
    fireEvent.click(screen.getByRole('button', { name: 'Move Organic up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grain' }));
    const picker = screen.getByLabelText('Add a filter');
    const offered = within(picker)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(offered).toContain('Size (Number)');
    expect(offered.some((text) => text?.startsWith('Notes'))).toBe(false);
    expect(offered.some((text) => text?.startsWith('Origin'))).toBe(false);
    fireEvent.change(picker, { target: { value: 'size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save attribute links' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `catalog/admin/categories/${id(2)}/attribute-links`,
        { featureSetId: id(51), filters: ['organic', 'size'], version: 7 },
        'csrf',
      ),
    );
  });

  it('switches to inheriting the parent’s feature set and sends null', async () => {
    serve(ownLinks);
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    fireEvent.click(await screen.findByLabelText('Inherit from Pantry'));
    expect(screen.queryByLabelText('Feature set for this category')).toBeNull();
    call.mockImplementation((method) => Promise.resolve(method === 'PUT' ? ok({}) : ok(ownLinks)));
    fireEvent.click(screen.getByRole('button', { name: 'Save attribute links' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        expect.any(String),
        expect.objectContaining({ featureSetId: null }),
        'csrf',
      ),
    );
  });

  it('offers only active feature sets and omits the version on a first save', async () => {
    serve({ categoryId: id(2), own: null, effective: { featureSet: null, filters: [] } });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    fireEvent.click(await screen.findByLabelText('Use its own feature set'));
    const select = screen.getByLabelText('Feature set for this category');
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual(['Pantry goods (pantry)', 'Rice (rice-set)']);
    fireEvent.click(screen.getByRole('button', { name: 'Save attribute links' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        expect.any(String),
        { featureSetId: id(50), filters: [] },
        'csrf',
      ),
    );
  });

  it('keeps Save off until something changed, and explains a stale save', async () => {
    serve(ownLinks);
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    const save = await screen.findByRole('button', { name: 'Save attribute links' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grain' }));
    expect((save as HTMLButtonElement).disabled).toBe(false);
    serve(ownLinks, fail(409, 'category-links.stale'));
    fireEvent.click(save);
    expect(await screen.findByText(/Someone else changed these links/)).toBeTruthy();
    // Reload leaves the editor and fetches the links again (it does not just cancel).
    serve(ownLinks);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('button', { name: 'Edit attribute links' })).toBeTruthy();
    expect(screen.queryByText(/Someone else changed these links/)).toBeNull();
  });

  it('explains a filter the API refuses', async () => {
    serve(ownLinks);
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Grain' }));
    serve(ownLinks, fail(422, 'category-links.filter-not-filterable'));
    fireEvent.click(screen.getByRole('button', { name: 'Save attribute links' }));
    expect(await screen.findByText(/not allowed as a filter/)).toBeTruthy();
  });

  it('returns to the read view after a save', async () => {
    serve(ownLinks);
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Grain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save attribute links' }));
    expect(await screen.findByText('Attribute links saved.')).toBeTruthy();
  });
});

describe('who sees the Attribute links tab', () => {
  beforeEach(() => {
    call.mockReset();
    stubDialog();
    call.mockImplementation((method, path) =>
      Promise.resolve(
        path.includes('/attribute-links') ? ok(inheritedLinks) : ok({ ...body } as never),
      ),
    );
  });
  afterEach(cleanup);

  const show = (attributeAccess: 'none' | 'view' | 'edit') =>
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CategoryDetails id={id(2)} attributeAccess={attributeAccess} />
      </NextIntlClientProvider>,
    );

  it('hides the tab without catalog.attribute.view', async () => {
    show('none');
    await screen.findByRole('button', { name: 'Details' });
    expect(screen.queryByRole('button', { name: 'Attribute links' })).toBeNull();
  });

  it('shows the tab to a reader and opens it', async () => {
    show('view');
    fireEvent.click(await screen.findByRole('button', { name: 'Attribute links' }));
    expect(await screen.findByText('Pantry goods')).toBeTruthy();
  });
});
