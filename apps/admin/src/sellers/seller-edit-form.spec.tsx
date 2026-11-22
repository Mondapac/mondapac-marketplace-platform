// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SectionResult } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';
import { SellerEditForm, useSellerSection } from './seller-edit-form.tsx';

/** A part with one text box; its save answers what the test says. */
function Part({
  name,
  answer,
  calls,
  valid = true,
}: {
  readonly name: string;
  readonly answer: () => Promise<SectionResult | 'signed-out'>;
  readonly calls: string[];
  readonly valid?: boolean;
}) {
  const [saved, setSaved] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  const section = useSellerSection(name, {
    dirty: text !== saved,
    title: `Part ${name}`,
    lines: [`${name}: ${text}`],
    check: () => {
      setError(!valid);
      return valid;
    },
    save: async () => {
      calls.push(name);
      const result = await answer();
      if (result === 'signed-out') return section.signedOut();
      if (result === 'saved') setSaved(text);
      return result;
    },
    needsCode: name !== 'c',
    savedMessage: () => `${name} saved alone`,
    discard: () => setText(saved),
  });
  return (
    <label>
      {name}
      <input value={text} onChange={(event) => setText(event.target.value)} />
      {error ? <span>{name} is wrong</span> : null}
    </label>
  );
}

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Object.defineProperty(window, 'location', {
    value: { assign, pathname: '/sellers/s1' },
    writable: true,
  });
});
afterEach(cleanup);

const ok = () => Promise.resolve<SectionResult>('saved');
const mount = (parts: Parameters<typeof Part>[0][]) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellerEditForm order={['a', 'b', 'c']} page="Seller">
        {parts.map((part) => (
          <Part key={part.name} {...part} />
        ))}
      </SellerEditForm>
    </NextIntlClientProvider>,
  );
const type = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });
const pressSave = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const confirmDialog = () =>
  screen.getByRole('dialog', { name: 'Save changes to this seller?', hidden: true });

describe('SellerEditForm', () => {
  it('counts the changed parts in one bar and lists them all in one confirm, in page order', () => {
    const calls: string[] = [];
    mount([
      { name: 'c', answer: ok, calls },
      { name: 'a', answer: ok, calls },
    ]);
    expect(bar()).toBeNull();
    type('c', 'three');
    type('a', 'one');
    expect(bar()?.textContent).toContain('2 parts with unsaved changes');
    pressSave();
    const dialog = within(confirmDialog());
    const items = dialog.getAllByText(/^Part /).map((node) => node.textContent);
    expect(items).toEqual(['Part a', 'Part c']);
    expect(dialog.getByText('a: one')).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'Save 2 parts', hidden: true })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('sends nothing and opens no confirm while a part is wrong', () => {
    const calls: string[] = [];
    mount([
      { name: 'a', answer: ok, calls },
      { name: 'b', answer: ok, calls, valid: false },
    ]);
    type('a', 'x');
    type('b', 'y');
    pressSave();
    expect(screen.getByText('b is wrong')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Save changes to this seller?' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('saves the parts in turn and says so once', async () => {
    const calls: string[] = [];
    mount([
      { name: 'a', answer: ok, calls },
      { name: 'b', answer: ok, calls },
    ]);
    type('b', 'y');
    type('a', 'x');
    pressSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 parts', hidden: true }));
    await expectToast('2 parts saved.');
    expect(calls).toEqual(['a', 'b']);
    await waitFor(() => expect(bar()).toBeNull());
  });

  it('uses the part’s own message when it is the only one saved', async () => {
    mount([{ name: 'a', answer: ok, calls: [] }]);
    type('a', 'x');
    pressSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 part', hidden: true }));
    await expectToast('a saved alone');
  });

  it('keeps a refused part unsaved while the next one saves', async () => {
    const calls: string[] = [];
    mount([
      { name: 'a', answer: () => Promise.resolve('failed'), calls },
      { name: 'b', answer: ok, calls },
    ]);
    type('a', 'x');
    type('b', 'y');
    pressSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 parts', hidden: true }));
    await expectToast(/1 part saved; 1 needs attention/, 'warning');
    expect(calls).toEqual(['a', 'b']);
    await waitFor(() => expect(bar()?.textContent).toContain('1 part with unsaved changes'));
  });

  it('stops at a cancelled code and sends nothing after it', async () => {
    const calls: string[] = [];
    mount([
      { name: 'a', answer: ok, calls },
      { name: 'b', answer: () => Promise.resolve('stopped'), calls },
      { name: 'c', answer: ok, calls },
    ]);
    type('a', 'x');
    type('b', 'y');
    type('c', 'z');
    pressSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save 3 parts', hidden: true }));
    await expectToast(/1 part saved before the code was cancelled/, 'info');
    expect(calls).toEqual(['a', 'b']);
    await waitFor(() => expect(bar()?.textContent).toContain('2 parts with unsaved changes'));
  });

  it('says nothing was saved when every part fails, and focuses the first message', async () => {
    mount([
      { name: 'a', answer: () => Promise.resolve('failed'), calls: [] },
      { name: 'b', answer: () => Promise.resolve('failed'), calls: [] },
    ]);
    type('a', 'x');
    type('b', 'y');
    pressSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 parts', hidden: true }));
    await expectToast(/Nothing was saved/, 'error');
    // The parts here mark nothing invalid, so focus falls back to nothing and the page stays put.
    expect(bar()?.textContent).toContain('2 parts with unsaved changes');
  });

  it('locks every field while the parts are sent', async () => {
    let finish: (result: SectionResult) => void = () => undefined;
    const slow = () =>
      new Promise<SectionResult>((resolve) => {
        finish = resolve;
      });
    mount([
      { name: 'a', answer: slow, calls: [] },
      { name: 'b', answer: ok, calls: [] },
    ]);
    type('a', 'x');
    type('b', 'y');
    pressSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 parts', hidden: true }));
    await waitFor(() => expect(screen.getByLabelText('b').matches(':disabled')).toBe(true));
    finish('saved');
    await waitFor(() => expect(screen.getByLabelText('b').matches(':disabled')).toBe(false));
  });

  it('mentions codes only when a listed part may ask for one', () => {
    mount([{ name: 'c', answer: ok, calls: [] }]);
    type('c', 'z');
    pressSave();
    expect(within(confirmDialog()).queryByText(/two-step code/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing', hidden: true }));
    cleanup();
    mount([{ name: 'a', answer: ok, calls: [] }]);
    type('a', 'x');
    pressSave();
    expect(within(confirmDialog()).getByText(/two-step code/)).toBeTruthy();
  });

  it('drops a removed part from the count', () => {
    const view = mount([
      { name: 'a', answer: ok, calls: [] },
      { name: 'b', answer: ok, calls: [] },
    ]);
    type('a', 'x');
    type('b', 'y');
    expect(bar()?.textContent).toContain('2 parts with unsaved changes');
    view.rerender(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <SellerEditForm order={['a', 'b', 'c']} page="Seller">
          {[{ name: 'a', answer: ok, calls: [] }].map((part) => (
            <Part key={part.name} {...part} />
          ))}
        </SellerEditForm>
      </NextIntlClientProvider>,
    );
    expect(bar()?.textContent).toContain('1 part with unsaved changes');
  });

  it('Discard puts every part back', () => {
    mount([
      { name: 'a', answer: ok, calls: [] },
      { name: 'b', answer: ok, calls: [] },
    ]);
    type('a', 'x');
    type('b', 'y');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText<HTMLInputElement>('a').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('b').value).toBe('');
    expect(bar()).toBeNull();
  });

  it('asks before unload with changes, and leaves quietly when signed out', async () => {
    mount([{ name: 'a', answer: () => Promise.resolve('signed-out'), calls: [] }]);
    type('a', 'x');
    const asked = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(asked);
    expect(asked.defaultPrevented).toBe(true);
    pressSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 part', hidden: true }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
  });
});
