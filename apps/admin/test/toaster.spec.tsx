// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@mondapac/ui';

const labels = { region: 'Action notifications', close: 'Close notification' };

afterEach(() => {
  cleanup();
  act(() => toast.dismiss());
});

describe('Toaster', () => {
  it('keeps an empty polite region ready, named by its label', () => {
    render(<Toaster labels={labels} />);
    const region = screen.getByRole('region', { name: 'Action notifications' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.children).toHaveLength(0);
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
});
