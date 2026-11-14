// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../../api/client.ts';
import type { Taxonomy } from '../editor/types.ts';
import { TaxonomyView } from './taxonomy-view.tsx';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const failed = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

const taxonomy: Taxonomy = {
  categories: [{ id: id(1), slug: 'recipes', position: 2, names: { 'en-AU': 'Recipes' } }],
  tags: [{ id: id(2), slug: 'eid', name: 'Eid' }],
  locales: { default: 'en-AU', supported: ['en-AU', 'ms-MY'] },
};

function serve(data: Taxonomy = taxonomy) {
  call.mockImplementation((...args: unknown[]) =>
    args[0] === 'GET' ? Promise.resolve(ok(data) as never) : Promise.resolve(ok({}) as never),
  );
}
function show(canEdit = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <TaxonomyView canEdit={canEdit} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');

describe('admin blog taxonomy', () => {
  beforeEach(() => call.mockReset());
  afterEach(cleanup);

  it('lists categories and tags, and offers no change to a reader', async () => {
    serve();
    show(false);
    expect(await screen.findByText('Recipes')).toBeTruthy();
    expect(screen.getByText('Eid')).toBeTruthy();
    expect(screen.getByText(/recipes · order 2/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add category' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/u })).toBeNull();
    expect(screen.getByText(/read the categories and tags but not change/u)).toBeTruthy();
  });

  it('adds a category with a name per Market language and reads the list again', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'spring-recipes' } });
    fireEvent.change(screen.getByLabelText('Name (en-AU)'), { target: { value: 'Spring' } });
    fireEvent.change(screen.getByLabelText(/Name \(ms-MY\)/u), {
      target: { value: 'Musim bunga' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [method, path, body, csrf] = writes()[0]!;
    expect([method, path, csrf]).toEqual(['POST', 'blog/admin/taxonomy/categories', 'csrf-1']);
    expect(body).toEqual({
      slug: 'spring-recipes',
      names: { 'en-AU': 'Spring', 'ms-MY': 'Musim bunga' },
    });
    await waitFor(() => expect(call.mock.calls.filter(([m]) => m === 'GET')).toHaveLength(2));
  });

  it('stops a bad address and a missing main-language name before any call', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'Bad Slug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/lowercase letters, numbers and single hyphens/iu)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'ok-slug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/main language/u)).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('changes the names of a category with PUT, without its address', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Recipes' }));
    const slug = screen.getByLabelText<HTMLInputElement>('Web address');
    expect(slug.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name (en-AU)'), { target: { value: 'Recipes 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [method, path, body] = writes()[0]!;
    expect([method, path]).toEqual(['PUT', `blog/admin/taxonomy/categories/${id(1)}`]);
    expect(body).toEqual({ names: { 'en-AU': 'Recipes 2' }, position: 2 });
  });

  it('asks before deleting, and says when a post uses the category', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Recipes' }));
    expect(screen.getByText('Delete Recipes?')).toBeTruthy();
    expect(writes()).toHaveLength(0);
    call.mockImplementation((...args: unknown[]) =>
      args[0] === 'GET'
        ? Promise.resolve(ok(taxonomy) as never)
        : Promise.resolve(failed(409, 'blog.category-in-use') as never),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete Recipes' }));
    expect(await screen.findByText(/A post uses this/u)).toBeTruthy();
    expect(writes()[0]!.slice(0, 2)).toEqual(['DELETE', `blog/admin/taxonomy/categories/${id(1)}`]);
  });

  it('adds a tag, with the address left to the server', async () => {
    serve();
    show();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: ' Slow cooker ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.slice(0, 3)).toEqual([
      'POST',
      'blog/admin/taxonomy/tags',
      { name: 'Slow cooker' },
    ]);
  });

  it('cannot add a category when the Market has no blog language settings', async () => {
    serve({ ...taxonomy, locales: null });
    show();
    expect(await screen.findByText(/no language settings/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add category' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows a retry when the lists cannot be loaded', async () => {
    call.mockResolvedValue(failed(500, 'x'));
    show();
    expect(await screen.findByText(/could not be loaded/u)).toBeTruthy();
  });

  it('deletes a tag after the question, and says when a post uses it', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Eid' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete Eid' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.slice(0, 2)).toEqual(['DELETE', `blog/admin/taxonomy/tags/${id(2)}`]);
    call.mockImplementation((...args: unknown[]) =>
      args[0] === 'GET'
        ? Promise.resolve(ok(taxonomy) as never)
        : Promise.resolve(failed(409, 'blog.tag-in-use') as never),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Eid' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete Eid' }));
    expect(await screen.findByText(/A post uses this/u)).toBeTruthy();
  });

  it('puts focus on Cancel when the question appears and back on Delete when cancelled', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Recipes' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Recipes' })),
    );
  });

  it('moves focus into the form and gives it back to the button on Cancel', async () => {
    serve();
    show();
    const edit = await screen.findByRole('button', { name: 'Edit Recipes' });
    fireEvent.click(edit);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Edit category' })),
    );
    expect(screen.getByRole('button', { name: 'Edit Recipes' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });

  it('reads the lists again and closes the form when the category is gone', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Recipes' }));
    call.mockImplementation((...args: unknown[]) =>
      args[0] === 'GET'
        ? Promise.resolve(ok({ ...taxonomy, categories: [] }) as never)
        : Promise.resolve(failed(404, 'blog.category-not-found') as never),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/no longer exists/u)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Recipes')).toBeNull());
    expect(screen.queryByRole('form', { name: 'Edit category' })).toBeNull();
  });

  it('shows a taken address and a refusal of the role, and sends the length-checked address only', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/single hyphens/u)).toBeTruthy();
    expect(writes()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'recipes' } });
    fireEvent.change(screen.getByLabelText('Name (en-AU)'), { target: { value: 'R' } });
    call.mockImplementation((...args: unknown[]) =>
      args[0] === 'GET'
        ? Promise.resolve(ok(taxonomy) as never)
        : Promise.resolve(failed(409, 'blog.category-slug-taken') as never),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/web address is already used/u)).toBeTruthy();
    call.mockImplementation((...args: unknown[]) =>
      args[0] === 'GET'
        ? Promise.resolve(ok(taxonomy) as never)
        : Promise.resolve(failed(403, 'access.denied') as never),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/role cannot change/u)).toBeTruthy();
  });

  it('refuses a bad tag address before any call and sends nothing twice while busy', async () => {
    serve();
    show();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Eid 2' } });
    fireEvent.change(screen.getByLabelText(/Web address/u), { target: { value: 'Bad Slug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(await screen.findByText(/single hyphens/u)).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('leaves out a language the Market no longer supports when editing', async () => {
    serve({
      ...taxonomy,
      categories: [
        {
          id: id(1),
          slug: 'recipes',
          position: 2,
          names: { 'en-AU': 'Recipes', 'fr-FR': 'Recettes' },
        },
      ],
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Recipes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toEqual({ names: { 'en-AU': 'Recipes' }, position: 2 });
  });
});
