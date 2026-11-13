// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { CategoryProposalsCard } from './category-proposals-card.tsx';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-000000000009';
const view = (canSeeQueue = true) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <CategoryProposalsCard sellerId={SELLER} csrfToken="tok" canSeeQueue={canSeeQueue} />
    </NextIntlClientProvider>,
  );

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('May propose categories', () => {
  it('turns the switch on and says what happened', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { allowed: true, changed: true } });
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Allow proposals' }));
    expect(await screen.findByText('This seller may now propose categories.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `sellers/admin/${SELLER}/category-proposals`,
      { allowed: true },
      'tok',
    );
  });

  it('says so when nothing changed, and when it is turned off', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { allowed: false, changed: false } });
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Stop proposals' }));
    expect(
      await screen.findByText(
        'This seller may no longer propose categories. It was already set this way.',
      ),
    ).toBeTruthy();
    expect(call.mock.calls[0]?.[3]).toBe('tok');
    expect(call.mock.calls[0]?.[2]).toEqual({ allowed: false });
  });

  it('shows a refusal, and links to the shelves only for an admin who may see them', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    view(false);
    fireEvent.click(screen.getByRole('button', { name: 'Allow proposals' }));
    expect(await screen.findByText("Your role can't change this setting.")).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    view(true);
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `/catalog/categories?tab=proposals&seller=${SELLER}`,
    );
  });
});
