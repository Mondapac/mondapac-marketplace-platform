// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { NewPostForm } from './new-post-form.tsx';

const call = vi.mocked(callApi);
const POST = '0190a000-0000-7000-8000-000000000001';
const show = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NewPostForm csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );

describe('new blog post form', () => {
  beforeEach(() => {
    call.mockReset();
  });
  afterEach(cleanup);

  it('asks for a title before it creates anything', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter a title.');
    expect(call).not.toHaveBeenCalled();
  });

  it('creates the draft with the chosen type and opens the editor on it', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    call.mockResolvedValue({ ok: true, status: 201, body: { id: POST } } as never);
    show();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'news' } });
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: '  Same-day delivery  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/content/blog/${POST}`));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'blog/admin/posts',
      { kind: 'news', content: { title: 'Same-day delivery', excerpt: '', body: [] } },
      'csrf-1',
    );
    vi.unstubAllGlobals();
  });

  it('shows why a create was refused and stays on the form', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'blog.slug-taken' },
    } as never);
    show();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already used/u);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create draft' }).disabled).toBe(
      false,
    );
  });
});
