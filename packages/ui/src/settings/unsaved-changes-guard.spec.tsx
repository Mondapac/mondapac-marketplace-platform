// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedChangesGuard } from './unsaved-changes-guard.tsx';

// Two forms on one page (an offer's sizes table and its shelf) each keep a guard: leaving asks
// once, and Leave goes through both.

const labels = {
  title: 'Leave without saving?',
  message: (info: { count: number; page: string }) => `${info.count} on ${info.page}`,
  stay: 'Stay',
  leave: 'Leave',
};

function Form({ page }: { readonly page: string }) {
  const guard = useUnsavedChangesGuard(true, labels, { count: 1, page });
  return guard.dialog;
}

// jsdom has no modal dialogs: open and close set the attribute, as a browser does.
const proto = HTMLDialogElement.prototype;
const originals = (['showModal', 'close'] as const).map(
  (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
);
beforeEach(() => {
  proto.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  proto.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(proto, name);
    else Object.defineProperty(proto, name, descriptor);
  }
});

describe('useUnsavedChangesGuard with two guards on a page', () => {
  it('asks once and leaves through both', () => {
    const followed = vi.fn((event: MouseEvent) => event.preventDefault());
    render(
      <>
        <Form page="Sizes" />
        <Form page="Shelf" />
        <a href="/orders" onClick={(event) => followed(event.nativeEvent)}>
          Orders
        </a>
      </>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Orders' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(followed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
    expect(followed).toHaveBeenCalledTimes(1);
  });
});
