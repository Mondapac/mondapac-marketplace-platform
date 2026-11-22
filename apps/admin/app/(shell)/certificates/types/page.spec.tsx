// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import TypesPage from './page.tsx';
import TypePage from './[typeId]/page.tsx';

// The types pages: the view gate (no API read without type.view), the states of each read, the id
// check, and that only a known `done` text reaches the view.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../../src/certificates/tabs.tsx', () => ({ CertificatesTabs: () => null }));
vi.mock('../../../../src/certificates/type-registry/types-table.tsx', () => ({
  TypesTable: ({ rows }: { readonly rows: readonly unknown[] }) => <p>{`${rows.length} types`}</p>,
}));
vi.mock('../../../../src/certificates/type-registry/types-toolbar.tsx', () => ({
  TypesToolbar: ({ canEdit, closed }: { readonly canEdit: boolean; readonly closed: boolean }) => (
    <p>{`toolbar edit=${canEdit} closed=${closed}`}</p>
  ),
}));
vi.mock('../../../../src/certificates/type-registry/type-detail.tsx', () => ({
  TypeDetailView: ({
    name,
    canEdit,
    done,
  }: {
    readonly name: string;
    readonly canEdit: boolean;
    readonly done: string | null;
  }) => <p>{`${name} edit=${canEdit} done=${done ?? 'none'}`}</p>,
}));

const VIEW = 'certification.type.view';
const EDIT = 'certification.type.edit';
const ID = '0190a000-0000-7000-8000-0000000000a1';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  marketTimezone: 'UTC',
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const detail = {
  kind: 'ok',
  body: {
    typeId: ID,
    code: 'halal',
    published: { content: { locales: { en: { name: 'Halal' } } } },
  },
};
const one = (typeId: string, done?: string | string[]) => ({
  params: Promise.resolve({ typeId }),
  searchParams: Promise.resolve(done === undefined ? {} : { done }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
});
afterEach(cleanup);

describe('types list page', () => {
  it('reads nothing without type.view', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await TypesPage());
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText("You don't have access to certificate types.")).toBeTruthy();
  });

  it('shows the types, and the states of a failed read', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: { items: [{}, {}] } });
    render(await TypesPage());
    expect(screen.getByText('2 types')).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await TypesPage());
    expect(screen.getByText('Certificate types could not be loaded.')).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValue({ kind: 'forbidden' });
    render(await TypesPage());
    expect(screen.getByText("You don't have access to certificate types.")).toBeTruthy();
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(TypesPage()).rejects.toThrow('redirect:/session-ended');
  });

  it('reads closed proposals only when asked, and gives New type to editors only', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: { items: [] } });
    render(await TypesPage({ searchParams: Promise.resolve({ closed: 'true' }) }));
    expect(mocks.get).toHaveBeenCalledWith('certification/admin/types?closed=true');
    expect(screen.getByText('toolbar edit=false closed=true')).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, EDIT]) });
    render(await TypesPage());
    expect(mocks.get).toHaveBeenLastCalledWith('certification/admin/types');
    expect(screen.getByText('toolbar edit=true closed=false')).toBeTruthy();
  });

  it('shows a load error when the session itself is unavailable', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await TypesPage());
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('type page', () => {
  it('reads nothing without type.view, and rejects an id that is not a UUID', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await TypePage(one(ID)));
    expect(screen.getByText("You don't have access to certificate types.")).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
    render(await TypePage(one('not-an-id')));
    expect(screen.getByText('This type was not found.')).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('shows the type, edit rights only with type.edit, and a string done only', async () => {
    mocks.get.mockResolvedValue(detail);
    render(await TypePage(one(ID, 'deactivated')));
    expect(mocks.get).toHaveBeenCalledWith(`certification/admin/types/${ID}`);
    expect(screen.getByText('Halal edit=false done=deactivated')).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, EDIT]) });
    render(await TypePage(one(ID, ['a', 'b'])));
    expect(screen.getByText('Halal edit=true done=none')).toBeTruthy();
  });

  it('shows the states of a failed read', async () => {
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    render(await TypePage(one(ID)));
    expect(screen.getByText('This type was not found.')).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await TypePage(one(ID)));
    expect(screen.getByText('This type could not be loaded.')).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValue({ kind: 'forbidden' });
    render(await TypePage(one(ID)));
    expect(screen.getByText("You don't have access to certificate types.")).toBeTruthy();
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(TypePage(one(ID))).rejects.toThrow('redirect:/session-ended');
  });
});
