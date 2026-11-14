// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { CategoriesField } from './categories-field.tsx';
import { categoryIssuesOf } from './category-issues.ts';
import { problemOf } from './errors.ts';

// The category field of the platform product form (categories C5b).

const call = vi.mocked(callApi);
const assign = vi.fn();
const choice = (
  id: string,
  path: string[],
  over: Partial<{ general: boolean; status: 'active' | 'hidden' }> = {},
) => ({
  id,
  level: path.length,
  name: path[path.length - 1],
  path,
  general: false,
  status: 'active',
  ...over,
});
const CHOICES = [
  choice('basmati', ['Pantry', 'Rice', 'Basmati']),
  choice('rice', ['Pantry', 'Rice'], { general: true }),
  choice('tea', ['Drinks', 'Tea'], { status: 'hidden' }),
];
const FORM_CATEGORIES = [
  { categoryId: 'pantry', parentId: null, names: { en: 'Pantry' } },
  { categoryId: 'rice', parentId: 'pantry', names: { en: 'Rice' } },
];

function Harness({
  initial = [],
  issues,
  onValue,
}: {
  initial?: string[];
  issues?: Parameters<typeof CategoriesField>[0]['issues'];
  onValue?: (ids: string[]) => void;
}) {
  const [ids, setIds] = useState(initial);
  return (
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <CategoriesField
        categories={FORM_CATEGORIES}
        categoryIds={ids}
        defaultLocale="en"
        issues={issues}
        onChange={(next) => {
          setIds(next);
          onValue?.(next);
        }}
      />
    </NextIntlClientProvider>
  );
}
const open = () => fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    value: { assign, href: 'http://admin.localhost/' },
    writable: true,
  });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('the category field of the platform product form', () => {
  it('reads the admin picker lazily and shows General and Hidden choices', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { locale: 'en', choices: CHOICES } });
    render(<Harness />);
    expect(call).not.toHaveBeenCalled();
    open();
    expect(await screen.findByRole('option', { name: /^Pantry › Rice › General/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Drinks › Tea\s*Hidden/ })).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual([
      'GET',
      'catalog/admin/platform-products/category-picker',
    ]);
  });

  it('shows a load failure and retries; a signed-out session goes to sign-in', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 500, code: 'x' } });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { locale: 'en', choices: CHOICES } });
    render(<Harness />);
    open();
    expect(await screen.findByText("We couldn't load the categories.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: /^Drinks › Tea/ })).toBeTruthy();
  });

  it('redirects to sign-in on a 401', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 401, code: 'identity.unauthenticated' },
    });
    render(<Harness />);
    open();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('adds, makes primary and removes, keeping the first as primary', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { locale: 'en', choices: CHOICES } });
    const seen = vi.fn();
    render(<Harness initial={['rice']} onValue={seen} />);
    expect(screen.getByRole('listitem').textContent).toContain('Pantry › , Rice');
    expect(screen.getByText('Primary')).toBeTruthy();
    open();
    fireEvent.click(await screen.findByRole('option', { name: /^Drinks › Tea/ }));
    expect(seen).toHaveBeenLastCalledWith(['rice', 'tea']);
    fireEvent.click(screen.getByRole('button', { name: /Make primary: Drinks › Tea/ }));
    expect(seen).toHaveBeenLastCalledWith(['tea', 'rice']);
    fireEvent.click(screen.getByRole('button', { name: /Remove Drinks › Tea/ }));
    expect(seen).toHaveBeenLastCalledWith(['rice']);
  });

  it('tells each refusal in words next to its category', () => {
    render(
      <Harness
        initial={['rice', 'basmati']}
        issues={{ list: 'too-many', items: { 0: 'level-not-allowed', 1: 'duplicate' } }}
      />,
    );
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent);
    expect(alerts).toEqual(
      expect.arrayContaining([
        'A product can be in at most 3 categories.',
        "Choose a more specific category. Products can't go on a department or group.",
        'You chose this category twice. Remove one.',
      ]),
    );
  });
});

describe('a refused publish', () => {
  it('moves category issues out of the raw lines', () => {
    const problem = problemOf({
      status: 422,
      code: 'revision.not-ready',
      details: {
        issues: [
          { path: 'categoryIds', code: 'required' },
          { path: 'categoryIds.2', code: 'unknown' },
          { path: 'attributes.size', code: 'required' },
        ],
      },
    });
    expect(problem.details).toEqual(['attributes.size: required']);
    expect(problem.categoryIssues).toEqual({ list: 'required', items: { 2: 'unknown' } });
    expect(categoryIssuesOf([]).items).toEqual({});
  });
});
