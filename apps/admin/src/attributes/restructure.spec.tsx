// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { AttributesView } from './attributes-view.tsx';
import type {
  AttributeDetail,
  AttributePage,
  ImpactAnswer,
  MarketLocales,
  OpenRelaxation,
} from './types.ts';

// Merging values, archiving and confirming an archive request in the panel (attributes A8), on
// two Markets: the impact is read first and its version is the one the write names; the buttons
// need `catalog.attribute.restructure`; a blocked archive says why; a material attribute is
// archived by a request.

const call = vi.mocked(callApi);
const WAITING_EMPTY = 'Nothing is waiting for you.';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const MARKETS: readonly { readonly name: string; readonly locales: MarketLocales }[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { name: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP', 'fa-IR'] } },
];

type Handler = ApiResult<unknown> | (() => ApiResult<unknown>);
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const refuse = (
  status: number,
  code: string,
  fields?: { path: string; code: string }[],
): ApiResult<unknown> => ({
  ok: false,
  failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
});
function serve(routes: Record<string, Handler>) {
  call.mockImplementation((method, path) => {
    const key = `${method} ${path}`;
    const hit = Object.keys(routes)
      .filter((route) => key.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    const handler = hit === undefined ? undefined : routes[hit];
    if (handler === undefined) throw new Error(`unexpected call ${key}`);
    return Promise.resolve((typeof handler === 'function' ? handler() : handler) as never);
  });
}
const writes = () => call.mock.calls.filter(([m]) => m === 'POST');

const detail = (locales: MarketLocales, over: Partial<AttributeDetail> = {}): AttributeDetail => ({
  id: id(1),
  code: 'pack-type',
  dataType: 'select',
  localizable: false,
  status: 'active',
  names: { [locales.default]: 'Pack type' },
  material: false,
  isVariantOption: false,
  revisionNo: 1,
  units: [],
  missingLocales: [],
  createdByKind: 'admin',
  createdAt: '2026-10-01T01:00:00.000Z',
  version: 4,
  bounds: {},
  display: {
    helpText: {},
    showOnProductPage: true,
    searchable: false,
    canBeFilter: false,
    internalNote: null,
    position: 0,
  },
  options: ['tin', 'can', 'jar'].map((code, position) => ({
    code,
    labels: { [locales.default]: code.toUpperCase() },
    active: true,
    position,
    productCount: 2,
    mergedInto: null,
  })),
  productCount: 6,
  usedIn: [],
  history: [],
  historyTruncated: false,
  locales,
  ...over,
});
const impact = (over: Partial<ImpactAnswer['impact']> = {}, version = 4): ImpactAnswer => ({
  attribute: {
    id: id(1),
    code: 'pack-type',
    status: 'active',
    version,
    material: false,
    isVariantOption: false,
    dataType: 'select',
  },
  impact: {
    publishedProducts: { count: 12, atLeast: false },
    drafts: { count: 3, atLeast: false },
    featureSetCount: 0,
    featureSets: [],
    categories: { count: 0, atLeast: false },
    filters: { count: 1, atLeast: false },
    liveVariantProducts: { count: 0, atLeast: false },
    ...over,
  },
});
const pageOf = (locales: MarketLocales): AttributePage => ({
  items: [],
  nextAfterId: null,
  total: 0,
  totalAll: 0,
  locales,
  units: [],
  featureSets: [],
  truncated: false,
});

function mount(canRestructure: boolean) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AttributesView
        canEdit={false}
        canRestructure={canRestructure}
        csrfToken="csrf-1"
        canSeeBrands={false}
        canDecide={false}
        initialTab="attributes"
        initialId={id(1)}
      />
    </NextIntlClientProvider>,
  );
}

describe.each(MARKETS)('attribute restructure in the panel ($name)', ({ locales }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/catalog/attributes');
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(cleanup);

  const base = (extra: Record<string, Handler> = {}) =>
    serve({
      'GET catalog/admin/attributes?': ok(pageOf(locales)),
      [`GET catalog/admin/attributes/${id(1)}/impact`]: ok(impact()),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales)),
      ...extra,
    });

  it('offers Merge values and Archive only with the restructure permission', async () => {
    base();
    mount(false);
    await screen.findByRole('heading', { name: 'Pack type' });
    expect(screen.queryByRole('button', { name: 'Merge values' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    cleanup();
    mount(true);
    await screen.findByRole('button', { name: 'Merge values' });
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('shows the impact, then merges the chosen values with the version it showed', async () => {
    base({
      [`POST catalog/admin/attributes/${id(1)}/merge-values`]: ok({
        attribute: { id: id(1), code: 'pack-type', status: 'active', version: 5, revisionNo: 2 },
      }),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge values' }));
    const dialog = await screen.findByRole('dialog');
    const list = await within(dialog)
      .findByRole('list', { hidden: true })
      .catch(() => null);
    expect(list).toBeNull();
    await within(dialog).findByText('Published products');
    expect(within(dialog).getByText('12')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Merge values' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Merge this value'), {
      target: { value: 'can' },
    });
    fireEvent.change(within(dialog).getByLabelText('Into this value'), {
      target: { value: 'tin' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await expectToast('Values merged.');
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/attributes/${id(1)}/merge-values`,
      { version: 4, source: 'can', target: 'tin' },
      'csrf-1',
    ]);
  });

  it('says "At least" when the server stopped counting', async () => {
    base({
      [`GET catalog/admin/attributes/${id(1)}/impact`]: ok(
        impact({ publishedProducts: { count: 10000, atLeast: true } }),
      ),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge values' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('At least 10000');
  });

  it('archives an attribute that nothing uses, with the version the impact showed', async () => {
    base({
      [`POST catalog/admin/attributes/${id(1)}/archive`]: ok({
        attribute: { id: id(1), code: 'pack-type', status: 'archived', version: 5, revisionNo: 1 },
      }),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Published products');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive attribute' }));
    await expectToast('Attribute archived.');
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/attributes/${id(1)}/archive`,
      { version: 4 },
      'csrf-1',
    ]);
  });

  it('blocks the archive while a feature set lists the attribute, and names them', async () => {
    base({
      [`GET catalog/admin/attributes/${id(1)}/impact`]: ok(
        impact({
          featureSetCount: 1,
          featureSets: [{ id: id(50), code: 'grocery-sauces', names: {} }],
        }),
      ),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/still in an active feature set/);
    expect(within(dialog).getByText('Feature sets: grocery-sauces')).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Archive attribute' }).disabled,
    ).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it('asks a second administrator to archive a material attribute', async () => {
    base({
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, { material: true })),
      [`GET catalog/admin/attributes/${id(1)}/impact`]: ok({
        ...impact(),
        attribute: { ...impact().attribute, material: true },
      }),
      [`POST catalog/admin/attributes/${id(1)}/archive-requests`]: ok({
        request: { id: id(801), attributeId: id(1), kind: 'archive', status: 'open' },
      }),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Published products');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await expectToast(
      'Request sent. A different administrator can confirm it under Waiting for you.',
    );
    expect(writes()[0]?.[1]).toBe(`catalog/admin/attributes/${id(1)}/archive-requests`);
  });

  it('shows the API refusal of a race: it moved to a feature set after the impact was read', async () => {
    base({
      [`POST catalog/admin/attributes/${id(1)}/archive`]: refuse(409, 'attribute.archive-blocked', [
        { path: 'attribute', code: 'in-feature-set' },
      ]),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Published products');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive attribute' }));
    await waitFor(() =>
      expect(within(dialog).getAllByText(/still in an active feature set/).length).toBeGreaterThan(
        0,
      ),
    );
  });

  it('confirms another administrator’s archive request on the archive route', async () => {
    const request: OpenRelaxation = {
      id: id(801),
      version: 1,
      kind: 'archive',
      attribute: {
        id: id(1),
        code: 'pack-type',
        names: { [locales.default]: 'Pack type' },
        version: 4,
      },
      mine: false,
      requestedByAccountId: id(901),
      requestedAt: '2026-11-04T10:00:00.000Z',
      expiresAt: '2026-11-07T10:00:00.000Z',
      allowedActions: {
        confirm: { allowed: true },
        cancel: { allowed: false, reason: 'relaxation.not-requester' },
      },
    };
    let open = [request];
    serve({
      'GET catalog/admin/attribute-relaxations': () => ok({ requests: [] }),
      'GET catalog/admin/attribute-archive-requests': () => ok({ requests: open }),
      [`POST catalog/admin/attribute-archive-requests/${id(801)}/confirm`]: () => {
        open = [];
        return ok({});
      },
    });
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <AttributesView
          canEdit
          canRestructure
          csrfToken="csrf-1"
          canSeeBrands={false}
          canDecide={false}
          initialTab="waiting"
          initialId={null}
        />
      </NextIntlClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm request for Pack type' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/archived at once/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await expectToast('Attribute archived.');
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/attribute-archive-requests/${id(801)}/confirm`,
      { version: 1 },
      'csrf-1',
    ]);
  });
  it('reads each waiting list with its own key', async () => {
    const reads = () => call.mock.calls.map(([, path]) => String(path));
    const view = (canEdit: boolean, canRestructure: boolean) => (
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <AttributesView
          canEdit={canEdit}
          canRestructure={canRestructure}
          csrfToken="csrf-1"
          canSeeBrands={false}
          canDecide={false}
          initialTab="waiting"
          initialId={null}
        />
      </NextIntlClientProvider>
    );
    serve({
      'GET catalog/admin/attribute-relaxations': ok({ requests: [] }),
      'GET catalog/admin/attribute-archive-requests': ok({ requests: [] }),
    });
    const only = async (canEdit: boolean, canRestructure: boolean) => {
      call.mockClear();
      render(view(canEdit, canRestructure));
      await screen.findByText(WAITING_EMPTY);
      const paths = reads();
      cleanup();
      return paths;
    };
    expect(await only(true, false)).toEqual(['catalog/admin/attribute-relaxations']);
    expect(await only(false, true)).toEqual(['catalog/admin/attribute-archive-requests']);
    expect((await only(true, true)).sort()).toEqual([
      'catalog/admin/attribute-archive-requests',
      'catalog/admin/attribute-relaxations',
    ]);
  });

  it('shows the load error when one of the two waiting lists fails', async () => {
    serve({
      'GET catalog/admin/attribute-relaxations': ok({ requests: [] }),
      'GET catalog/admin/attribute-archive-requests': refuse(500, 'internal'),
    });
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <AttributesView
          canEdit
          canRestructure
          csrfToken="csrf-1"
          canSeeBrands={false}
          canDecide={false}
          initialTab="waiting"
          initialId={null}
        />
      </NextIntlClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  describe('merge into another attribute', () => {
    const targetRow = (over: Partial<AttributePage['items'][number]> = {}) => ({
      id: id(2),
      code: 'container',
      dataType: 'select' as const,
      localizable: false,
      status: 'active' as const,
      names: { [locales.default]: 'Container' },
      material: false,
      isVariantOption: false,
      revisionNo: 1,
      missingLocales: [],
      productCount: 4,
      featureSetCount: 1,
      ...over,
    });
    const targetDetail = () =>
      detail(locales, {
        id: id(2),
        code: 'container',
        version: 7,
        names: { [locales.default]: 'Container' },
        options: ['tin', 'bottle'].map((code, position) => ({
          code,
          labels: { [locales.default]: code === 'tin' ? 'Tin' : 'Bottle' },
          active: true,
          position,
          productCount: 1,
          mergedInto: null,
        })),
      });
    const merging = (extra: Record<string, Handler> = {}) =>
      base({
        'GET catalog/admin/attributes?': ok({ ...pageOf(locales), items: [targetRow()] }),
        [`GET catalog/admin/attributes/${id(2)}`]: ok(targetDetail()),
        ...extra,
      });

    it('is offered with the restructure key, and not for a material attribute', async () => {
      base();
      mount(false);
      await screen.findByRole('heading', { name: 'Pack type' });
      expect(screen.queryByRole('button', { name: 'Merge into attribute' })).toBeNull();
      cleanup();
      mount(true);
      expect(await screen.findByRole('button', { name: 'Merge into attribute' })).toBeTruthy();
      cleanup();
      base({ [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, { material: true })) });
      mount(true);
      await screen.findByRole('button', { name: 'Archive' });
      expect(screen.queryByRole('button', { name: 'Merge into attribute' })).toBeNull();
    });

    it('maps every value, then merges with both versions it read', async () => {
      merging({
        [`POST catalog/admin/attributes/${id(1)}/merge`]: ok({
          attribute: {
            id: id(1),
            code: 'pack-type',
            status: 'archived',
            version: 5,
            revisionNo: 1,
          },
        }),
      });
      mount(true);
      fireEvent.click(await screen.findByRole('button', { name: 'Merge into attribute' }));
      const dialog = await screen.findByRole('dialog');
      const confirm = within(dialog).getByRole('button', { name: 'Merge attributes' });
      await within(dialog).findByText('Published products');
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(await within(dialog).findByLabelText('Merge into'), {
        target: { value: id(2) },
      });
      // The value with the same code is mapped already; the others are asked for.
      await within(dialog).findByLabelText('TIN goes to');
      expect(within(dialog).getByLabelText<HTMLSelectElement>('TIN goes to').value).toBe('tin');
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText('CAN goes to'), { target: { value: 'tin' } });
      fireEvent.change(within(dialog).getByLabelText('JAR goes to'), {
        target: { value: 'bottle' },
      });
      expect((confirm as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(confirm);
      await expectToast('Attribute merged.');
      expect(writes()[0]).toEqual([
        'POST',
        `catalog/admin/attributes/${id(1)}/merge`,
        {
          version: 4,
          target: id(2),
          targetVersion: 7,
          options: { tin: 'tin', can: 'tin', jar: 'bottle' },
        },
        'csrf-1',
      ]);
    });

    it('says when there is no other attribute of the type', async () => {
      base();
      mount(true);
      fireEvent.click(await screen.findByRole('button', { name: 'Merge into attribute' }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('No other active attribute of this type to merge into.');
    });

    it('names why an attribute still in a feature set cannot be merged', async () => {
      merging({
        [`POST catalog/admin/attributes/${id(1)}/merge`]: refuse(409, 'attribute.merge-blocked', [
          { path: 'attribute', code: 'in-feature-set' },
        ]),
      });
      mount(true);
      fireEvent.click(await screen.findByRole('button', { name: 'Merge into attribute' }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('Published products');
      fireEvent.change(await within(dialog).findByLabelText('Merge into'), {
        target: { value: id(2) },
      });
      await within(dialog).findByLabelText('TIN goes to');
      fireEvent.change(within(dialog).getByLabelText('CAN goes to'), { target: { value: 'tin' } });
      fireEvent.change(within(dialog).getByLabelText('JAR goes to'), { target: { value: 'tin' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Merge attributes' }));
      await within(dialog).findByText(
        'It is still in an active feature set. Remove it from those feature sets first.',
      );
    });
  });

  describe('convert type', () => {
    it('is offered with the restructure key, for a select and a whole number only', async () => {
      base();
      mount(false);
      await screen.findByRole('heading', { name: 'Pack type' });
      expect(screen.queryByRole('button', { name: 'Convert type' })).toBeNull();
      cleanup();
      mount(true);
      expect(await screen.findByRole('button', { name: 'Convert type' })).toBeTruthy();
      for (const over of [
        { material: true },
        { isVariantOption: true },
        { dataType: 'text' as const, options: [] },
      ]) {
        cleanup();
        base({ [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, over)) });
        mount(true);
        await screen.findByRole('button', { name: 'Archive' });
        expect(screen.queryByRole('button', { name: 'Convert type' })).toBeNull();
      }
      cleanup();
      base({
        [`GET catalog/admin/attributes/${id(1)}`]: ok(
          detail(locales, { dataType: 'integer', options: [] }),
        ),
      });
      mount(true);
      expect(await screen.findByRole('button', { name: 'Convert type' })).toBeTruthy();
    });

    it('shows the impact, then converts with the version it showed', async () => {
      base({
        [`POST catalog/admin/attributes/${id(1)}/convert`]: ok({
          attribute: { id: id(1), code: 'pack-type', status: 'active', version: 5, revisionNo: 2 },
        }),
      });
      mount(true);
      fireEvent.click(await screen.findByRole('button', { name: 'Convert type' }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('Published products');
      expect(within(dialog).getByText(/read as a list of one/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Convert type' }));
      await expectToast('Type converted.');
      expect(writes()[0]).toEqual([
        'POST',
        `catalog/admin/attributes/${id(1)}/convert`,
        { version: 4, to: 'multi-select' },
        'csrf-1',
      ]);
    });

    it('asks for a decimal when the attribute is a whole number', async () => {
      base({
        [`GET catalog/admin/attributes/${id(1)}`]: ok(
          detail(locales, { dataType: 'integer', options: [] }),
        ),
        [`POST catalog/admin/attributes/${id(1)}/convert`]: ok({
          attribute: { id: id(1), code: 'pack-type', status: 'active', version: 5, revisionNo: 2 },
        }),
      });
      mount(true);
      fireEvent.click(await screen.findByRole('button', { name: 'Convert type' }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('Published products');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Convert type' }));
      await expectToast('Type converted.');
      expect(writes()[0]?.[2]).toEqual({ version: 4, to: 'decimal' });
    });

    it('names why an attribute others were merged into cannot be converted', async () => {
      base({
        [`POST catalog/admin/attributes/${id(1)}/convert`]: refuse(
          409,
          'attribute-definition.convert-merged',
        ),
      });
      mount(true);
      fireEvent.click(await screen.findByRole('button', { name: 'Convert type' }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('Published products');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Convert type' }));
      await within(dialog).findByText(
        'Other attributes were merged into this one, so its type has to stay as it is.',
      );
    });
  });
});
