// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/en.json';
import type { AdminSession } from '../../../../../src/server/session.ts';
import IssuerRequestPage from './page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  view: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../../../src/certificates/requests/request-view.tsx', () => ({
  RequestView: (props: { canAnswer: boolean; typeName: string; csrfToken: string }) => {
    mocks.view(props);
    return <p>{`request ${props.typeName} ${props.canAnswer ? 'answer' : 'no-answer'}`}</p>;
  },
}));

const ID = '0190a000-0000-7000-8000-0000000000e1';
const VIEW = 'certification.issuer.view';
const EDIT = 'certification.issuer.edit';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  marketTimezone: 'Australia/Brisbane',
  csrfToken: 'c',
});
const props = (id = ID) => ({ params: Promise.resolve({ issuerRequestId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue({ kind: 'ok', body: { typeCode: 'halal' } });
});
afterEach(cleanup);

describe('issuer request route', () => {
  it('reads nothing without the issuer view permission, nor for an id that is not a UUID', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await IssuerRequestPage(props()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.certificates.requests.detail['no-access'])).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
    render(await IssuerRequestPage(props('nope')));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.certificates.requests.detail['not-found'])).toBeTruthy();
  });

  it('lets only an issuer editor answer, and hands the view the token and type name', async () => {
    render(await IssuerRequestPage(props()));
    expect(mocks.get).toHaveBeenCalledWith(`certification/admin/issuer-requests/${ID}`);
    expect(screen.getByText('request halal no-answer')).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, EDIT]) });
    render(await IssuerRequestPage(props()));
    expect(screen.getByText('request halal answer')).toBeTruthy();
    expect(mocks.view.mock.calls.at(-1)?.[0]).toMatchObject({ csrfToken: 'c' });
  });

  it('handles refused, missing, unavailable and signed-out reads', async () => {
    mocks.get.mockResolvedValueOnce({ kind: 'forbidden' });
    render(await IssuerRequestPage(props()));
    expect(screen.getByText(messages.certificates.requests.detail['no-access'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'not-found' });
    render(await IssuerRequestPage(props()));
    expect(screen.getByText(messages.certificates.requests.detail['not-found'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    render(await IssuerRequestPage(props()));
    expect(screen.getByText(messages.certificates.requests.detail.unavailable)).toBeTruthy();
    mocks.get.mockResolvedValueOnce({ kind: 'signed-out' });
    await expect(IssuerRequestPage(props())).rejects.toThrow('redirect:/session-ended');
  });
});
