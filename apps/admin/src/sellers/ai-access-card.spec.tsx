// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AiAccessCard, aiAccessOf } from './ai-access-card.tsx';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-000000000009';
const view = (initial: Parameters<typeof AiAccessCard>[0]['initial'], canView = true) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AiAccessCard sellerId={SELLER} csrfToken="tok" initial={initial} canView={canView} />
    </NextIntlClientProvider>,
  );

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('AI writing help card', () => {
  it('shows the setting as read, and when it last changed', () => {
    view({ enabled: true, changedAt: '2026-11-02T01:00:00Z' });
    expect(
      screen.getByRole('switch', { name: 'AI writing help' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByText(/Last changed/)).toBeTruthy();
  });

  it('is off and never changed by default', () => {
    view({ enabled: false, changedAt: null });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Not changed yet.')).toBeTruthy();
  });

  it('turns it on, sends the body and confirms inline from the answer', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { enabled: true, changed: true } });
    view({ enabled: false, changedAt: null });
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('AI writing help is now on for this seller.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `sellers/admin/${SELLER}/ai-access`,
      { enabled: true },
      'tok',
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('Not changed yet.')).toBeNull();
  });

  it('says so when the switch already held the value', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { enabled: false, changed: false } });
    view({ enabled: true, changedAt: null });
    fireEvent.click(screen.getByRole('switch'));
    expect(
      await screen.findByText(
        'AI writing help is now off for this seller. It was already set this way.',
      ),
    ).toBeTruthy();
  });

  it('keeps the switch where it was and shows a refusal', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    view({ enabled: false, changedAt: null });
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText("Your role can't change this setting.")).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('shows a notice and no switch when the setting could not be read', () => {
    view(null);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('The current setting could not be read.')).toBeTruthy();
    expect(screen.queryByText(/Reload the page/)).toBeNull();
    expect(screen.queryByText(/have access/)).toBeNull();
  });

  it('says there is no access, with no switch, when the admin lacks the view key', () => {
    view(null, false);
    expect(screen.getByText("You don't have access to this setting.")).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it('checks the read answer', () => {
    expect(aiAccessOf({ enabled: true, changedAt: null })).toEqual({
      enabled: true,
      changedAt: null,
    });
    expect(aiAccessOf({})).toBeNull();
    expect(aiAccessOf(null)).toBeNull();
  });
});
