// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  SaveBar,
  SAVE_BAR_OFFSET_VAR,
  SettingInput,
  SettingRow,
  SettingsPage,
  SettingsSection,
  Toaster,
  toast,
} from '@mondapac/ui';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const leave = { title: 'Leave without saving?', message: 'Lost.', stay: 'Stay', leave: 'Leave' };
const barLabels = { region: 'Unsaved changes', discard: 'Discard', save: 'Save', saving: 'Saving' };

function Page({ initial = '' }: { initial?: string }) {
  const [text, setText] = useState(initial);
  const dirty = text !== initial;
  return (
    <SettingsPage
      title="Page"
      dirty={dirty}
      leave={leave}
      onSubmit={() => {}}
      saveBar={
        <SaveBar
          count={dirty ? 1 : 0}
          summary="1 unsaved change"
          labels={barLabels}
          onDiscard={() => setText(initial)}
        />
      }
    >
      <SettingsSection title="S">
        <SettingRow label="Name" changed={dirty}>
          <SettingInput value={text} onChange={(event) => setText(event.target.value)} />
        </SettingRow>
      </SettingsSection>
      <a href="/orders">Orders</a>
      <a href="#fees">Jump</a>
      <a href="https://elsewhere.example.com/">Elsewhere</a>
    </SettingsPage>
  );
}

beforeEach(() => {
  // jsdom has no modal <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  cleanup();
  act(() => toast.dismiss());
  document.documentElement.style.removeProperty(SAVE_BAR_OFFSET_VAR);
});

describe('settings page guard', () => {
  it('lets a link through while nothing is unsaved', () => {
    render(<Page />);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => void screen.getByText('Orders').dispatchEvent(click));
    expect(click.defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before an in-app link is followed, and Stay keeps the page and the edit', () => {
    render(<Page />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => void screen.getByText('Orders').dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('x');
  });

  it('follows the link after Leave, once', () => {
    render(<Page />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    const followed = vi.fn((event: Event) => {
      if (event.target instanceof HTMLAnchorElement) event.preventDefault();
    });
    // Bubble phase on the document: sees only a link click the guard let through.
    document.addEventListener('click', followed);
    try {
      act(
        () =>
          void screen
            .getByText('Orders')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
      );
      expect(followed).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
      expect(
        followed.mock.calls.filter(([e]) => e.target instanceof HTMLAnchorElement),
      ).toHaveLength(1);
    } finally {
      document.removeEventListener('click', followed);
    }
  });

  it('ignores a jump on this page and an external link', () => {
    render(<Page />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    for (const name of ['Jump', 'Elsewhere']) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => void screen.getByText(name).dispatchEvent(click));
      expect(click.defaultPrevented).toBe(false);
    }
  });

  it('asks the browser before a reload only while unsaved', () => {
    render(<Page />);
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    const asks = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(asks);
    expect(asks.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const again = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });
});

describe('save bar and toasts', () => {
  it('raises the toast stack above the bar while it shows, and lets go when it goes', () => {
    render(<Page />);
    const root = document.documentElement;
    expect(root.style.getPropertyValue(SAVE_BAR_OFFSET_VAR)).toBe('');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    expect(root.style.getPropertyValue(SAVE_BAR_OFFSET_VAR)).toMatch(/^\d+px$/);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(root.style.getPropertyValue(SAVE_BAR_OFFSET_VAR)).toBe('');
  });

  it('reads the offset in the toaster, and clears it when the page unmounts', () => {
    const view = render(
      <>
        <Toaster labels={{ region: 'Action notifications', close: 'Close' }} />
        <Page initial="a" />
      </>,
    );
    expect(screen.getByRole('region', { name: 'Action notifications' }).className).toContain(
      'var(--mp-savebar-offset,0px)',
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'b' } });
    expect(document.documentElement.style.getPropertyValue(SAVE_BAR_OFFSET_VAR)).not.toBe('');
    view.unmount();
    expect(document.documentElement.style.getPropertyValue(SAVE_BAR_OFFSET_VAR)).toBe('');
  });
});
