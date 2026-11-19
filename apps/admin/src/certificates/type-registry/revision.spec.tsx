// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { typeProblemOf } from './errors.ts';
import { TypeDetailView } from './type-detail.tsx';
import { TypeRevisionForm } from './type-revision-form.tsx';
import type { TypeDetail } from './types.ts';

const call = vi.mocked(callApi);
const TYPE = '0190a000-0000-7000-8000-0000000000a1';
const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
const detail = (over: Partial<TypeDetail['published']['content']> = {}): TypeDetail => ({
  typeId: TYPE,
  code: 'halal',
  status: 'active',
  version: 3,
  published: {
    revisionNo: 2,
    createdAt: '2026-11-01T01:00:00.000Z',
    content: {
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: false,
      defaultBasis: 'SELLER_REQUIRED',
      autoApproveSelfDeclaration: false,
      badgeIconKey: 'shield-check',
      locales: {
        'en-AU': {
          name: 'Halal',
          customerDescription: 'Halal certified',
          claimTerms: ['halal', 'zabiha'],
        },
      },
      ...over,
    },
  },
  pendingRevision: null,
  pendingReactivation: null,
});
const form = (type = detail()) => wrap(<TypeRevisionForm type={type} csrfToken="c" />);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

let assigned = '';
beforeEach(() => {
  call.mockReset();
  assigned = '';
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
  vi.stubGlobal('location', {
    ...window.location,
    assign: (url: string) => {
      assigned = url;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('type revision form', () => {
  it('starts from the published revision and keeps the check method fixed', () => {
    form();
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Halal');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Claim terms').value).toBe('halal\nzabiha');
    expect(screen.getByText(/cannot be changed/)).toBeTruthy();
    expect(screen.queryByLabelText('Approve without a person')).toBeNull();
  });

  it('asks for a change before it shows the confirmation', () => {
    form();
    click('Review changes');
    expect(screen.getByText('Nothing has changed yet.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows what changes, then saves the whole content under the version read', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { outcome: 'published', typeId: TYPE, revisionNo: 3 },
    });
    form();
    fireEvent.click(screen.getByLabelText('Needs an expiry date'));
    fireEvent.change(screen.getByLabelText('Claim terms'), {
      target: { value: 'halal\nzabiha\n  dhabiha  \n' },
    });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: ' new rule ' } });
    click('Review changes');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Needs an expiry date')).toBeTruthy();
    expect(within(dialog).getByText(/dhabiha/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the change' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/types/${TYPE}/revisions`,
      {
        version: 3,
        reason: 'new rule',
        content: {
          verificationMode: 'THIRD_PARTY_DOCUMENT',
          requiresIssuerRegistry: true,
          requiresDocument: true,
          requiresExpiry: true,
          defaultBasis: 'SELLER_REQUIRED',
          autoApproveSelfDeclaration: false,
          badgeIconKey: 'shield-check',
          locales: {
            'en-AU': {
              name: 'Halal',
              customerDescription: 'Halal certified',
              claimTerms: ['halal', 'zabiha', 'dhabiha'],
            },
          },
        },
      },
      'c',
    );
    await waitFor(() =>
      expect(assigned).toBe(`/certificates/types/${TYPE}?done=revision-published`),
    );
  });

  it('sends the person to the waiting notice when the API says a second admin is needed', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { outcome: 'pending-second-admin', typeId: TYPE, revisionNo: 3 },
    });
    form();
    fireEvent.click(screen.getByLabelText('Needs a document'));
    click('Review changes');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save the change' }),
    );
    await waitFor(() => expect(assigned).toBe(`/certificates/types/${TYPE}?done=revision-pending`));
  });

  it('shows the self-declaration switch only for a self-declared type', () => {
    form(detail({ verificationMode: 'SELF_DECLARATION' }));
    expect(screen.getByLabelText('Approve without a person')).toBeTruthy();
  });

  it('refuses an empty name, a bad icon key and no terms at all before it asks', () => {
    form();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('Icon'), { target: { value: 'Shield Check' } });
    fireEvent.change(screen.getByLabelText('Claim terms'), { target: { value: '' } });
    click('Review changes');
    expect(screen.getByText(/Enter a name/)).toBeTruthy();
    expect(screen.getByText(/lowercase letters, digits and hyphens, starting/)).toBeTruthy();
    expect(screen.getByText(/Add at least one claim term/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and lists what the API refused', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        code: 'type.revision-invalid',
        details: { issues: [{ path: 'locales.en-AU', code: 'type.claim-term-unmatchable' }] },
      },
    });
    form();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Halal food' } });
    click('Review changes');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save the change' }),
    );
    await screen.findByText('A claim term is too short to be matched.');
    expect(assigned).toBe('');
  });

  it('offers a reload when the type moved on meanwhile', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    form();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Halal food' } });
    click('Review changes');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save the change' }),
    );
    await screen.findByRole('button', { name: 'Reload the page' });
  });
});

describe('type revision entry points', () => {
  it('links an editor to the form and nobody else', () => {
    const { unmount } = wrap(<TypeDetailView type={detail()} name="Halal" canEdit csrfToken="c" />);
    expect(screen.getByRole('link', { name: 'Change this type' }).getAttribute('href')).toBe(
      `/certificates/types/${TYPE}/edit`,
    );
    unmount();
    wrap(<TypeDetailView type={detail()} name="Halal" canEdit={false} csrfToken="c" />);
    expect(screen.queryByRole('link', { name: 'Change this type' })).toBeNull();
  });

  it('shows the notice after a publish and after a wait', () => {
    const { unmount } = wrap(
      <TypeDetailView type={detail()} name="Halal" canEdit csrfToken="c" done="revision-pending" />,
    );
    expect(
      screen.getByText(/A second admin has to approve it before it is published/),
    ).toBeTruthy();
    unmount();
    wrap(
      <TypeDetailView
        type={detail()}
        name="Halal"
        canEdit
        csrfToken="c"
        done="revision-published"
      />,
    );
    expect(screen.getByText('Change published.')).toBeTruthy();
  });

  it('names the refusals of a revision and keeps the issue codes it knows', () => {
    const problem = typeProblemOf({
      status: 422,
      code: 'type.revision-invalid',
      details: {
        issues: [
          { path: 'a', code: 'type.text-invalid' },
          { path: 'b', code: 'type.text-invalid' },
          { path: 'c', code: 'something.else' },
        ],
      },
    });
    expect(problem.key).toBe('certificates.types.error.revision-invalid');
    expect(problem.issues).toEqual(['text-invalid']);
    expect(typeProblemOf({ status: 409, code: 'type.revision-unchanged' }).key).toBe(
      'certificates.types.error.unchanged',
    );
  });
});
