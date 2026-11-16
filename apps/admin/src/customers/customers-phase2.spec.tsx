// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { Toaster } from '@mondapac/ui';
import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { CustomerGroups } from './customer-groups.tsx';
import { CustomerPage } from './customer-page.tsx';
import { CustomersBulk } from './customers-bulk.tsx';
import { CustomersList } from './customers-list.tsx';
import { GroupPage } from './group-page.tsx';
import {
  activityHref,
  type ActivityEntry,
  type ActivityPage,
  type CustomerGroup,
  type CustomerNote,
} from './groups-types.ts';
import {
  DEFAULT_QUERY,
  apiFilters,
  filtersOfApi,
  selectorOf,
  type CustomerRow,
  type CustomersPage,
} from './list-types.ts';
import type { CustomerOverview } from './page-types.ts';

// Customers management phase 2a in the panel: groups (list filter and column, bulk add and
// remove, the groups pages), the name edit, notes and the activity timeline. Two Markets: the
// rows carry AUD and NZD, and no Market is assumed.

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>
      {node}
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </StepUpProvider>
  </NextIntlClientProvider>
);
const ok = <T,>(body: T, status = 200): ApiResult<T> => ({ ok: true, status, body });
const refused = (status: number, code: string, details?: object): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

const ID = '0190a000-0000-7000-8000-0000000000a1';
const G1 = '0190a000-0000-7000-8000-0000000000b1';
const G2 = '0190a000-0000-7000-8000-0000000000b2';
const G3 = '0190a000-0000-7000-8000-0000000000b3';
const VIEW = 'customers.customers.view';
const MANAGE = 'customers.groups.manage';
const EDIT = 'customers.customers.edit';
const NOTES = 'customers.customer-notes.write';

const group = (over: Partial<CustomerGroup> = {}): CustomerGroup => ({
  groupId: G1,
  name: 'Ramadan regulars',
  description: 'Bought during Ramadan',
  kind: 'manual',
  archived: false,
  archivedAt: null,
  memberCount: 12,
  createdByAccountId: 'admin-1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  version: 3,
  ...over,
});
const groups = [
  group(),
  group({ groupId: G2, name: 'Wholesale' }),
  group({ groupId: G3, name: 'Old list', archived: true, archivedAt: '2026-11-05T00:00:00.000Z' }),
];

const row = (over: Partial<CustomerRow> = {}): CustomerRow => ({
  accountId: ID,
  email: 'sara@example.com',
  displayName: 'Sara Ahmadi',
  status: 'active',
  emailVerified: true,
  signedUpAt: '2026-10-01T02:30:00.000Z',
  lastOrderAt: null,
  orderCount: 0,
  spentMinor: '0',
  currency: 'NZD',
  refundCount: 0,
  groups: [],
  ...over,
});
const counts = {
  all: 3,
  new: 0,
  active: 3,
  inactive: 0,
  'never-ordered': 3,
  disabled: 0,
  'pending-deletion': 0,
};
const listPage = (items: readonly CustomerRow[], total = items.length): CustomersPage => ({
  items,
  counts,
  paging: { total, page: 1, pageSize: 25, maxRows: 10_000 },
  nextCursor: null,
});

const listProps = {
  accountId: 'admin-1',
  marketId: 'NZ',
  marketName: 'New Zealand',
  zone: 'Pacific/Auckland',
  paging: 'pages' as const,
  csrfToken: 'csrf',
};

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const bodiesTo = (path: string) =>
  call.mock.calls.filter((args) => args[1] === path).map((args) => args[2]);

describe('the group filter of the list query', () => {
  it('sends the group id and reads it back from a saved filter', () => {
    const query = { ...DEFAULT_QUERY, filters: { group: G1 } };
    expect(selectorOf(query)).toEqual({ view: 'all', filters: { group: G1 } });
    expect(filtersOfApi(apiFilters(query.filters))).toEqual({ group: G1 });
    expect(filtersOfApi({ group: 'not-an-id' })).toEqual({});
  });
});

describe('activity links', () => {
  const entry = (ref: ActivityEntry['ref']): ActivityEntry => ({
    entryId: 'e1',
    kind: 'order-paid',
    category: 'orders',
    occurredAt: '2026-11-10T00:00:00.000Z',
    ref,
    actor: null,
    detail: null,
  });
  it('opens an order from the customer and a group page; a note has nothing to open', () => {
    expect(activityHref(entry({ type: 'order', id: 'o-1' }), ID)).toBe(
      `/orders/o-1?customer=${ID}&from=orders`,
    );
    expect(activityHref(entry({ type: 'group', id: G1 }), ID)).toBe(`/customers/groups/${G1}`);
    expect(activityHref(entry({ type: 'note', id: 'n' }), ID)).toBeNull();
    expect(activityHref(entry(null), ID)).toBeNull();
  });
});

function routeList(items: readonly CustomerRow[] = [row()]) {
  call.mockImplementation((method, path) => {
    if (path.startsWith('customers/admin/saved-filters')) {
      return Promise.resolve(
        ok({
          items: [],
          canShare: false,
          limits: { perOwner: 50, shared: 20 },
        }) as ApiResult<never>,
      );
    }
    if (path === 'customers/admin/groups') {
      return Promise.resolve(ok({ items: groups }) as ApiResult<never>);
    }
    if (path === 'customers/admin/list') {
      return Promise.resolve(ok(listPage(items)) as ApiResult<never>);
    }
    if (path === `customers/admin/groups/${G1}`) {
      return Promise.resolve(ok(group()) as ApiResult<never>);
    }
    if (path.endsWith('/members/add') || path.endsWith('/members/remove')) {
      return Promise.resolve(ok({ changed: 1, requested: 2 }) as ApiResult<never>);
    }
    return Promise.resolve(refused(404, 'unknown'));
  });
}

describe('the Customers list with groups', () => {
  it('shows the Groups column as chips with "+N", and the Group filter chip by name', async () => {
    const many = [
      { groupId: G1, name: 'Ramadan regulars', archived: false },
      { groupId: G2, name: 'Wholesale', archived: false },
      { groupId: G3, name: 'Old list', archived: true },
    ];
    routeList([row({ groups: many })]);
    window.localStorage.setItem(
      'mp:admin:NZ:admin-1:customers-columns',
      JSON.stringify(['status', 'groups']),
    );
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    expect(
      (await screen.findByRole('link', { name: 'Ramadan regulars' })).getAttribute('href'),
    ).toBe(`/customers/groups/${G1}`);
    expect(screen.getByRole('link', { name: 'Wholesale' })).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    window.localStorage.clear();
  });

  it('scopes a group page to its group: every read carries it, with no chip and no saved filters', async () => {
    routeList();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} group={group()} />));
    await screen.findByRole('link', { name: 'Sara Ahmadi' });
    expect(bodiesTo('customers/admin/list')[0]).toMatchObject({ filters: { group: G1 } });
    expect(
      call.mock.calls.some((args) => args[1].startsWith('customers/admin/saved-filters')),
    ).toBe(false);
    expect(screen.queryByText(/Group: /)).toBeNull();
    expect(screen.getByText('3 members of Ramadan regulars')).toBeTruthy();
  });
});

describe('Add to group… and Remove from group… in the Bulk menu', () => {
  const selection = {
    ids: [ID, '0190a000-0000-7000-8000-0000000000a2'],
    allMatching: false,
    total: 3,
  };
  const groupRefs = groups.map((item) => ({
    groupId: item.groupId,
    name: item.name,
    archived: item.archived,
  }));

  it('adds the ticked customers to the picked live group and says how many were skipped', async () => {
    routeList();
    const done = vi.fn();
    render(
      wrap(
        <CustomersBulk
          selection={selection}
          query={DEFAULT_QUERY}
          columns={[]}
          permissionKeys={[VIEW, MANAGE]}
          csrfToken="csrf"
          groups={groupRefs}
          onSelectAll={() => undefined}
          onClear={() => undefined}
          onMembersChanged={done}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Add to group…/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add 2 customers to a group' });
    // An archived group takes no new members, so it is not offered.
    const picker = within(dialog).getByLabelText('Group');
    expect(within(picker).queryByRole('option', { name: /Old list/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to group' }));
    expect(await within(dialog).findByText('Choose a group.')).toBeTruthy();
    fireEvent.change(picker, { target: { value: G2 } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to group' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `customers/admin/groups/${G2}/members/add`,
      { ids: selection.ids },
      'csrf',
    );
    expect(
      await screen.findByText('1 customer added to Wholesale; 1 skipped (already in).'),
    ).toBeTruthy();
  });

  it('removes every matching customer from a group page’s own group with the selector', async () => {
    routeList();
    render(
      wrap(
        <CustomersBulk
          selection={{ ids: [], allMatching: true, total: 3 }}
          query={{ ...DEFAULT_QUERY, view: 'active', filters: { group: G1 } }}
          columns={[]}
          permissionKeys={[VIEW, MANAGE]}
          csrfToken="csrf"
          group={group()}
          onSelectAll={() => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    expect(screen.queryByRole('menuitem', { name: /Add to group…/ })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Remove from this group…/ }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove 3 customers from a group',
    });
    expect(within(dialog).queryByLabelText('Group')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from group' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `customers/admin/groups/${G1}/members/remove`,
        { view: 'active', filters: { group: G1 } },
        'csrf',
      ),
    );
  });

  it('refuses more ticked rows than one change takes, and shows nothing without a key', () => {
    routeList();
    const { unmount } = render(
      wrap(
        <CustomersBulk
          selection={{
            ids: Array.from({ length: 1001 }, (_, index) => `id-${index}`),
            allMatching: false,
            total: 2000,
          }}
          query={DEFAULT_QUERY}
          columns={[]}
          permissionKeys={[VIEW, MANAGE]}
          csrfToken="csrf"
          groups={groupRefs}
          onSelectAll={() => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Add to group…/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    render(
      wrap(
        <CustomersBulk
          selection={selection}
          query={DEFAULT_QUERY}
          columns={[]}
          permissionKeys={[VIEW]}
          csrfToken="csrf"
          onSelectAll={() => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    expect(screen.queryByRole('button', { name: 'Bulk action' })).toBeNull();
  });
});

describe('the Customer groups page', () => {
  it('lists live groups, shows archived ones in their own view, and makes a new group', async () => {
    routeList();
    call.mockImplementation((method, path) => {
      if (path === 'customers/admin/groups' && method === 'GET') {
        return Promise.resolve(ok({ items: groups }) as ApiResult<never>);
      }
      if (path === 'customers/admin/groups' && method === 'POST') {
        return Promise.resolve(
          ok(
            group({ groupId: '0190a000-0000-7000-8000-0000000000b9', name: 'VIP' }),
          ) as ApiResult<never>,
        );
      }
      return Promise.resolve(refused(404, 'unknown'));
    });
    render(
      wrap(
        <CustomerGroups permissionKeys={[VIEW, MANAGE]} csrfToken="csrf" zone="Pacific/Auckland" />,
      ),
    );
    expect(await screen.findByRole('link', { name: 'Ramadan regulars' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Old list' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }));
    expect(await screen.findByRole('link', { name: 'Old list' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Live (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'New group…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  VIP  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
    expect(await screen.findByRole('link', { name: 'VIP' })).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', 'customers/admin/groups', { name: 'VIP' }, 'csrf');
  });

  it('says a taken name on the field, and archives with the version read', async () => {
    call.mockImplementation((method, path) => {
      if (path === 'customers/admin/groups' && method === 'GET') {
        return Promise.resolve(ok({ items: groups }) as ApiResult<never>);
      }
      if (path === 'customers/admin/groups' && method === 'POST') {
        return Promise.resolve(refused(409, 'customers.group-name-taken'));
      }
      if (path === `customers/admin/groups/${G1}` && method === 'PUT') {
        return Promise.resolve(ok(group({ archived: true, version: 4 })) as ApiResult<never>);
      }
      return Promise.resolve(refused(404, 'unknown'));
    });
    render(wrap(<CustomerGroups permissionKeys={[VIEW, MANAGE]} csrfToken="csrf" zone="UTC" />));
    await screen.findByRole('link', { name: 'Ramadan regulars' });
    fireEvent.click(screen.getByRole('button', { name: 'New group…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'wholesale' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
    expect(await within(dialog).findByText('A group with this name already exists.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ramadan regulars' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive Ramadan regulars?' });
    expect(within(confirm).getByText(/12 members stay in the group/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive group' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `customers/admin/groups/${G1}`,
        { expectedVersion: 3, archived: true },
        'csrf',
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Ramadan regulars' })).toBeNull(),
    );
  });

  it('offers no change to an admin without the manage key', async () => {
    call.mockResolvedValue(ok({ items: groups }));
    render(wrap(<CustomerGroups permissionKeys={[VIEW]} csrfToken="csrf" zone="UTC" />));
    await screen.findByRole('link', { name: 'Ramadan regulars' });
    expect(screen.queryByRole('button', { name: 'New group…' })).toBeNull();
  });
});

describe('a group page', () => {
  it('shows the group and its members, and says when it is archived', async () => {
    routeList();
    call.mockImplementation((method, path) => {
      if (path === `customers/admin/groups/${G1}`) {
        return Promise.resolve(
          ok(group({ archived: true, archivedAt: '2026-11-05T00:00:00.000Z' })) as ApiResult<never>,
        );
      }
      if (path === 'customers/admin/list') {
        return Promise.resolve(ok(listPage([row()])) as ApiResult<never>);
      }
      return Promise.resolve(refused(404, 'unknown'));
    });
    render(wrap(<GroupPage groupId={G1} {...listProps} permissionKeys={[VIEW, MANAGE]} />));
    expect(await screen.findByRole('heading', { name: 'Ramadan regulars' })).toBeTruthy();
    expect(screen.getByText(/This group is archived/)).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Sara Ahmadi' })).toBeTruthy();
  });

  it('says a missing group plainly', async () => {
    call.mockResolvedValue(refused(404, 'customers.group-not-found'));
    render(wrap(<GroupPage groupId={G1} {...listProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('Group not found')).toBeTruthy();
  });
});

const overview = (over: Partial<CustomerOverview> = {}): CustomerOverview => ({
  ...row({ currency: 'AUD', orderCount: 2, spentMinor: '5000' }),
  firstOrderAt: null,
  refundedMinor: '0',
  deletionRequest: null,
  ...over,
});
const note = (over: Partial<CustomerNote> = {}): CustomerNote => ({
  noteId: 'n1',
  body: 'Called about a late order.\n<b>not bold</b>',
  authorAccountId: 'admin-2',
  authorName: 'Leila',
  byYou: false,
  createdAt: '2026-11-12T03:00:00.000Z',
  ...over,
});
const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  entryId: 'e1',
  kind: 'order-paid',
  category: 'orders',
  occurredAt: '2026-11-10T00:00:00.000Z',
  ref: { type: 'order', id: 'o-1' },
  actor: null,
  detail: null,
  ...over,
});
const activity = (
  items: readonly ActivityEntry[],
  total: number | null = items.length,
): ActivityPage => ({
  items,
  page: 1,
  pageSize: 25,
  paging: total === null ? 'prev-next' : 'pages',
  total,
  hasNext: false,
});

const pageProps = {
  accountId: ID,
  adminAccountId: 'admin-1',
  marketId: 'AU',
  initialTab: 'overview' as const,
  csrfToken: 'csrf',
  zone: 'Australia/Brisbane',
  paging: 'pages' as const,
  waitingPeriodDays: null,
};

function routePage(
  over: {
    overview?: CustomerOverview;
    notes?: readonly CustomerNote[];
    rename?: ApiResult<unknown>;
  } = {},
) {
  call.mockImplementation((method, path) => {
    if (path === `customers/admin/customers/${ID}`) {
      return Promise.resolve(ok(over.overview ?? overview()) as ApiResult<never>);
    }
    if (path.startsWith(`customers/admin/customers/${ID}/notes`) && method === 'GET') {
      const items = over.notes ?? [];
      return Promise.resolve(
        ok({ items, total: items.length, nextCursor: null }) as ApiResult<never>,
      );
    }
    if (path === `customers/admin/customers/${ID}/notes` && method === 'POST') {
      return Promise.resolve(ok({ noteId: 'n9' }) as ApiResult<never>);
    }
    if (path === `customers/admin/customers/${ID}/activity`) {
      return Promise.resolve(
        ok(
          activity([
            entry(),
            entry({
              entryId: 'e2',
              kind: 'page-opened',
              category: 'admin',
              ref: null,
              actor: { accountId: 'admin-2', name: 'Leila' },
              detail: 'money',
            }),
          ]),
        ) as ApiResult<never>,
      );
    }
    if (path === `customers/admin/customers/${ID}/display-name`) {
      return Promise.resolve((over.rename ?? ok({})) as ApiResult<never>);
    }
    if (path === 'customers/admin/groups') {
      return Promise.resolve(ok({ items: groups }) as ApiResult<never>);
    }
    if (path.endsWith('/members/add') || path.endsWith('/members/remove')) {
      return Promise.resolve(ok({ changed: 1, requested: 1 }) as ApiResult<never>);
    }
    return Promise.resolve(refused(404, 'unknown'));
  });
}

describe('the customer page, phase 2a', () => {
  it('renames the customer with Edit…, and says why a disabled account keeps its name', async () => {
    routePage({ rename: refused(409, 'customers.customer-not-eligible') });
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, EDIT]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit customer' });
    const field = within(dialog).getByLabelText('Display name');
    expect((field as HTMLInputElement).value).toBe('Sara Ahmadi');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Sara A.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/A disabled or unverified account keeps its name/),
    ).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `customers/admin/customers/${ID}/display-name`,
      { displayName: 'Sara A.' },
      'csrf',
    );
  });

  it('saves the new name into the header', async () => {
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, EDIT]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit customer' });
    fireEvent.change(within(dialog).getByLabelText('Display name'), {
      target: { value: 'Sara A.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sara A.' })).toBeTruthy();
  });

  it('has no Edit… without the edit key', async () => {
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW]} />));
    await screen.findByRole('heading', { level: 1, name: 'Sara Ahmadi' });
    expect(screen.queryByRole('button', { name: 'Edit…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add note…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to group…' })).toBeNull();
  });

  it('shows the groups as chips and takes the customer out of one after a confirmation', async () => {
    routePage({
      overview: overview({ groups: [{ groupId: G1, name: 'Ramadan regulars', archived: false }] }),
    });
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, MANAGE]} />));
    expect(await screen.findByRole('link', { name: 'Ramadan regulars' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Ramadan regulars' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove 1 customer from a group' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from group' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `customers/admin/groups/${G1}/members/remove`,
        { ids: [ID] },
        'csrf',
      ),
    );
  });

  it('offers only groups the customer is not in yet', async () => {
    routePage({
      overview: overview({ groups: [{ groupId: G1, name: 'Ramadan regulars', archived: false }] }),
    });
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, MANAGE]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to group…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add 1 customer to a group' });
    const picker = await within(dialog).findByLabelText('Group');
    expect(within(picker).queryByRole('option', { name: 'Ramadan regulars' })).toBeNull();
    expect(within(picker).getByRole('option', { name: 'Wholesale' })).toBeTruthy();
  });

  it('says when the customer is in no group', async () => {
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('Not in any group.')).toBeTruthy();
  });

  it('shows notes as plain text with the author, and adds one', async () => {
    routePage({
      notes: [note(), note({ noteId: 'n2', body: null, byYou: true, authorName: 'Me' })],
    });
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, NOTES]} />));
    // Markup in a note is text, never rendered.
    expect(await screen.findByText(/<b>not bold<\/b>/)).toBeTruthy();
    const notes = screen.getByRole('list', { name: 'Notes, newest first' });
    expect(within(notes).getByText(/^Leila · /)).toBeTruthy();
    expect(within(notes).getByText(/^You · /)).toBeTruthy();
    expect(screen.getByText('Text removed when the account was deleted.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add note…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a note' });
    fireEvent.change(within(dialog).getByLabelText('Note'), {
      target: { value: '  Prefers email.  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `customers/admin/customers/${ID}/notes`,
        { body: 'Prefers email.' },
        'csrf',
      ),
    );
  });

  it('shows the recent activity, and the whole timeline in the side panel by category', async () => {
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW]} />));
    expect(await screen.findAllByText('Paid for an order')).not.toHaveLength(0);
    expect(screen.getByText('Opened the Money tab')).toBeTruthy();
    expect(bodiesTo(`customers/admin/customers/${ID}/activity`)[0]).toEqual({
      page: 1,
      pageSize: 5,
      paging: 'prev-next',
    });
    fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
    const panel = await screen.findByRole('dialog', { name: 'Activity' });
    await within(panel).findByRole('table');
    fireEvent.click(within(panel).getByRole('button', { name: 'Orders' }));
    await waitFor(() =>
      expect(bodiesTo(`customers/admin/customers/${ID}/activity`).at(-1)).toMatchObject({
        filters: { category: 'orders' },
        direction: 'desc',
        paging: 'pages',
      }),
    );
    // No export without the export key.
    expect(within(panel).queryByRole('button', { name: 'Export…' })).toBeNull();
  });
});
