// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import ReviewPageRoute from './page.tsx';

// The review page route: the review gate (no API read without it), an id that is not a UUID, the
// states of the read, the one passed-on reason, and the decide permission.

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
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../../src/certificates/review/review-view.tsx', () => ({
  ReviewView: (props: {
    readonly canDecide: boolean;
    readonly typeName: string;
    readonly page: unknown;
  }) => {
    mocks.view(props);
    return <p>{`review ${props.typeName} ${props.canDecide ? 'decide' : 'no-decide'}`}</p>;
  },
}));

const ID = '0190a000-0000-7000-8000-0000000000c1';
const REVIEW = 'certification.seller-certificate.review';
const APPROVE = 'certification.seller-certificate.approve';
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
  csrfToken: 'c',
});
const props = (id = ID, reason?: string) => ({
  params: Promise.resolve({ certificateId: id }),
  searchParams: Promise.resolve(reason === undefined ? {} : { reason }),
});
const ok = {
  kind: 'ok',
  body: {
    certificate: {
      certificateId: ID,
      sellerId: 's',
      typeCode: 'halal',
      status: 'x',
      version: 1,
      createdAt: 'd',
    },
    submission: { submissionId: 'u', issuer: null, secret: 'decrypted-extra' },
    documents: [],
    checks: [],
    scope: null,
    confirmation: null,
    reasons: {},
    duplicateHints: [],
    business: { status: 'ok' },
    history: [],
    decision: null,
    otherSubmissions: [{ certificateNumber: 'OTHER-SELLER-NUMBER' }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([REVIEW]) });
  mocks.get.mockResolvedValue(ok);
});
afterEach(cleanup);

describe('review page route', () => {
  it('reads nothing without the review permission', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['certification.seller-certificate.view']),
    });
    render(await ReviewPageRoute(props()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.certificates.review['no-access'])).toBeTruthy();
  });

  it('says not found for an id that is not a UUID, without reading', async () => {
    render(await ReviewPageRoute(props('nope')));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.certificates.review['not-found'])).toBeTruthy();
  });

  it('passes on only the duplicate-hint reason', async () => {
    render(await ReviewPageRoute(props(ID, 'duplicate-hint')));
    expect(mocks.get).toHaveBeenCalledWith(
      `certification/admin/seller-certificates/${ID}?reason=duplicate-hint`,
    );
    cleanup();
    await ReviewPageRoute(props(ID, 'x&y=1'));
    expect(mocks.get).toHaveBeenLastCalledWith(`certification/admin/seller-certificates/${ID}`);
  });

  it('lets only an approve holder decide', async () => {
    render(await ReviewPageRoute(props()));
    expect(screen.getByText('review halal no-decide')).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([REVIEW, APPROVE]) });
    render(await ReviewPageRoute(props()));
    expect(screen.getByText('review halal decide')).toBeTruthy();
  });

  it('hands the view only the fields it shows, and the permission and token it needs', async () => {
    render(await ReviewPageRoute(props()));
    const given = mocks.view.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(given.page)).not.toContain('OTHER-SELLER-NUMBER');
    expect(JSON.stringify(given.page)).not.toContain('decrypted-extra');
    expect(given.canReview).toBe(true);
    expect(given.csrfToken).toBe('c');
    expect(given.typeName).toBe('halal');
  });

  it('handles refused, missing, unavailable and signed-out reads', async () => {
    mocks.get.mockResolvedValueOnce({ kind: 'forbidden' });
    render(await ReviewPageRoute(props()));
    expect(screen.getByText(messages.certificates.review['no-access'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'not-found' });
    render(await ReviewPageRoute(props()));
    expect(screen.getByText(messages.certificates.review['not-found'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    render(await ReviewPageRoute(props()));
    expect(screen.getByText(messages.certificates.review.unavailable)).toBeTruthy();
    mocks.get.mockResolvedValueOnce({ kind: 'signed-out' });
    await expect(ReviewPageRoute(props())).rejects.toThrow('redirect:/session-ended');
  });
});
