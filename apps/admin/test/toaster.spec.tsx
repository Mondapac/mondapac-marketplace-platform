// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOAST_FLASH_KEY, Toaster, toast } from '@mondapac/ui';

const labels = { region: 'Action notifications', close: 'Close notification' };

afterEach(() => {
  cleanup();
  act(() => toast.dismiss());
});

describe('Toaster', () => {
  it('keeps an empty named region ready, named by its label', () => {
    render(<Toaster labels={labels} />);
    const region = screen.getByRole('region', { name: 'Action notifications' });
    expect(region.hasAttribute('aria-live')).toBe(false);
    expect(region.children).toHaveLength(0);
  });

  it('has no close button on a loading toast, and gives one back with its result', async () => {
    render(<Toaster labels={labels} />);
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    act(() => {
      void toast.promise(work, { pending: 'Saving…', success: 'Saved.', error: 'Failed.' });
    });
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close notification' })).toBeNull();
    await act(async () => {
      finish('done');
      await work;
    });
    expect(screen.getByText('Saved.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Close notification' })).toHaveLength(1);
  });

  it('announces an error as an alert and the other types as status', () => {
    render(<Toaster labels={labels} />);
    act(() => {
      toast.success('Saved');
      toast.error('Failed');
      toast.info('FYI');
      toast.warning('Waits for room');
    });
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(['Saved', 'FYI']);
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    // The fourth waits in the queue until one is closed.
    expect(screen.queryByText('Waits for room')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close notification' })[0]!);
    expect(screen.getByText('Waits for room')).toBeTruthy();
  });

  it('shows the title as the bold line with the text and description under it', () => {
    render(<Toaster labels={labels} />);
    act(() => {
      toast.info('We will tell you here.', {
        title: 'Export is being prepared',
        description: 'CSV',
      });
    });
    const paragraphs = screen.getByRole('status').querySelectorAll('p');
    expect([...paragraphs].map((p) => p.textContent)).toEqual([
      'Export is being prepared',
      'We will tell you here.',
      'CSV',
    ]);
  });

  it('closes a toast with its close button, without moving focus', () => {
    render(<Toaster labels={labels} />);
    act(() => {
      toast.error('Failed', { id: 'a' });
    });
    const before = document.activeElement;
    fireEvent.click(screen.getByRole('button', { name: 'Close notification' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it('closes the toast that has focus on Escape and leaves the others', () => {
    render(<Toaster labels={labels} />);
    act(() => {
      toast.error('First', { id: 'a' });
      toast.error('Second', { id: 'b' });
    });
    const [firstClose] = screen.getAllByRole('button', { name: 'Close notification' });
    firstClose!.focus();
    fireEvent.keyDown(firstClose!, { key: 'Escape' });
    expect(screen.getAllByRole('alert').map((el) => el.textContent)).toEqual(['Second']);
  });

  it('runs the action and then closes the toast', () => {
    const onClick = vi.fn();
    render(<Toaster labels={labels} />);
    act(() => {
      toast.success('Slide archived', { action: { label: 'Undo', onClick } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Slide archived')).toBeNull();
  });

  it('pauses the progress bar while the pointer is on the toast', () => {
    render(<Toaster labels={labels} />);
    act(() => {
      toast.success('Saved');
    });
    const bar = () => document.querySelector<HTMLElement>('[data-toast-bar]')!;
    expect(bar().style.animationPlayState).toBe('running');
    expect(bar().style.animationDuration).toBe('5000ms');
    fireEvent.pointerEnter(screen.getByRole('status'));
    expect(bar().style.animationPlayState).toBe('paused');
    fireEvent.pointerLeave(screen.getByRole('status'));
    expect(bar().style.animationPlayState).toBe('running');
  });

  it('has no progress bar on an error, which stays until closed', () => {
    render(<Toaster labels={labels} />);
    act(() => {
      toast.error('Failed');
    });
    expect(document.querySelector('[data-toast-bar]')).toBeNull();
  });

  it('pauses while the tab is hidden', () => {
    render(<Toaster labels={labels} />);
    act(() => {
      toast.success('Saved');
    });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(document.querySelector<HTMLElement>('[data-toast-bar]')!.style.animationPlayState).toBe(
      'paused',
    );
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  });

  it('plays a short exit before removing a closed toast, and none under reduced motion', () => {
    vi.useFakeTimers();
    const media = (reduce: boolean) =>
      vi.fn(() => ({
        matches: reduce,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    try {
      window.matchMedia = media(false) as unknown as typeof window.matchMedia;
      render(<Toaster labels={labels} />);
      act(() => {
        toast.error('Failed', { id: 'a' });
      });
      fireEvent.click(screen.getByRole('button', { name: 'Close notification' }));
      expect(screen.getByRole('alert').hasAttribute('data-exiting')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(screen.queryByRole('alert')).toBeNull();

      cleanup();
      window.matchMedia = media(true) as unknown as typeof window.matchMedia;
      render(<Toaster labels={labels} />);
      act(() => {
        toast.error('Failed', { id: 'b' });
      });
      fireEvent.click(screen.getByRole('button', { name: 'Close notification' }));
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the flash of the page before it once, on mount', () => {
    sessionStorage.clear();
    toast.flash('success', 'Role saved');
    const first = render(<Toaster labels={labels} />);
    expect(screen.getByRole('status').textContent).toContain('Role saved');
    expect(sessionStorage.getItem(TOAST_FLASH_KEY)).toBeNull();
    first.unmount();
    act(() => toast.dismiss());
    // A later page has no flash left to show.
    render(<Toaster labels={labels} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
