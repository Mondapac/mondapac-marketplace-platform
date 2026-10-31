// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { UserMenu } from './user-menu.tsx';

afterEach(cleanup);

describe('admin account menu', () => {
  it('lists My profile, Signed-in devices, then Account security', () => {
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <UserMenu name="Ada" email="ada@example.test" theme="system" csrfToken="c" />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Account menu for Ada' }));
    const links = screen
      .getAllByRole('link')
      .map((item) => [item.textContent, item.getAttribute('href')]);
    expect(links).toEqual([
      ['My profile', '/account/profile'],
      ['Signed-in devices', '/account/sessions'],
      ['Account security', '/account/security'],
    ]);
  });
});
