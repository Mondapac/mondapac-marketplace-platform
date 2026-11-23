// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationDrawer } from '../notifications/notification-drawer.tsx';
import { SidePanel } from './side-panel.tsx';

const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  else Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
});

const noop = () => undefined;
const labels = {
  title: 'Notifications',
  close: 'Close',
  filters: 'Filter',
  unread: 'Unread',
  read: 'Read',
  all: 'All',
  unreadCount: 'unread',
  soundOn: 'On',
  soundOff: 'Off',
  markAll: 'Mark all as read',
  loadMore: 'More',
  unreadItem: 'Unread',
  empty: {
    unread: { title: 'a', body: 'b' },
    read: { title: 'a', body: 'b' },
    all: { title: 'a', body: 'b' },
  },
  error: 'e',
  retry: 'r',
  loading: 'l',
};

function drawer(open: boolean) {
  return (
    <NotificationDrawer
      open={open}
      onClose={noop}
      unread={0}
      filter="unread"
      onFilter={noop}
      list={{ kind: 'loading' }}
      onOpenItem={noop}
      onMarkAll={noop}
      markingAll={false}
      onLoadMore={noop}
      onRetry={noop}
      labels={labels}
    />
  );
}

describe('modal sheets and page scroll', () => {
  it('freezes the page while a sheet is open and releases it when it closes', () => {
    const view = render(drawer(true));
    expect(document.documentElement.style.overflow).toBe('hidden');
    view.rerender(drawer(false));
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('keeps the page frozen until the last of two stacked modals closes', () => {
    const a = render(drawer(true));
    const b = render(
      <SidePanel open title="T" closeLabel="Close" onClose={noop}>
        x
      </SidePanel>,
    );
    b.unmount();
    expect(document.documentElement.style.overflow).toBe('hidden');
    a.unmount();
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('leaves the scrolling to the list: the sheet itself never scrolls', () => {
    render(drawer(true));
    const dialog = document.querySelector('dialog');
    expect(dialog?.className).toContain('overflow-hidden');
  });
});
