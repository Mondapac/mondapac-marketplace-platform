import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore, toastDuration, type ToastStore } from './toast-store.ts';

let store: ToastStore;
const ids = () => store.getSnapshot().visible.map((item) => item.id);

beforeEach(() => {
  vi.useFakeTimers();
  store = createToastStore();
});
afterEach(() => {
  store.dismiss();
  vi.useRealTimers();
});

describe('toast durations', () => {
  it('gives each type its time, a longer one with an action, and none to an error', () => {
    expect(toastDuration('success')).toBe(5000);
    expect(toastDuration('info')).toBe(6000);
    expect(toastDuration('warning')).toBe(8000);
    expect(toastDuration('success', { action: { label: 'Undo', onClick: () => undefined } })).toBe(
      10000,
    );
    expect(toastDuration('error')).toBe(Infinity);
    expect(toastDuration('loading')).toBe(Infinity);
    expect(toastDuration('success', { duration: 1200 })).toBe(1200);
  });

  it.each([
    ['success', 5000],
    ['info', 6000],
    ['warning', 8000],
  ] as const)('removes a %s toast after %i ms', (type, ms) => {
    store.show(type, 'Done', { id: 'a' });
    vi.advanceTimersByTime(ms - 1);
    expect(ids()).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it('keeps a toast with an action for 10 s', () => {
    store.show('success', 'Archived', {
      id: 'a',
      action: { label: 'Undo', onClick: () => undefined },
    });
    vi.advanceTimersByTime(9999);
    expect(ids()).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it('never removes an error by itself, even with an action', () => {
    store.show('error', 'Failed', {
      id: 'e',
      action: { label: 'Try again', onClick: () => undefined },
    });
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(ids()).toEqual(['e']);
    store.dismiss('e');
    expect(ids()).toEqual([]);
  });
});

describe('toast queue', () => {
  it('shows three at most, newest last, and the rest wait', () => {
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => store.show('error', id, { id }));
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(store.getSnapshot().queued).toBe(2);
    store.dismiss('b');
    expect(ids()).toEqual(['a', 'c', 'd']);
    expect(store.getSnapshot().queued).toBe(1);
  });

  it('starts the timer of a queued toast only when it gets room', () => {
    store.show('error', 'a', { id: 'a' });
    store.show('error', 'b', { id: 'b' });
    store.show('error', 'c', { id: 'c' });
    store.show('success', 'd', { id: 'd' });
    vi.advanceTimersByTime(60000);
    expect(ids()).toEqual(['a', 'b', 'c']);
    store.dismiss('a');
    expect(ids()).toEqual(['b', 'c', 'd']);
    vi.advanceTimersByTime(4999);
    expect(ids()).toContain('d');
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual(['b', 'c']);
  });

  it('replaces a toast with the same id in place and restarts its timer', () => {
    store.show('success', 'one', { id: 'same' });
    store.show('error', 'other', { id: 'other' });
    vi.advanceTimersByTime(4000);
    store.show('warning', 'two', { id: 'same' });
    const [first] = store.getSnapshot().visible;
    expect(ids()).toEqual(['same', 'other']);
    expect(first).toMatchObject({ type: 'warning', text: 'two', revision: 1 });
    vi.advanceTimersByTime(7999);
    expect(ids()).toEqual(['same', 'other']);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual(['other']);
  });

  it('returns the id, and makes one when none is given', () => {
    expect(store.show('info', 'x', { id: 'mine' })).toBe('mine');
    const made = store.show('info', 'y');
    expect(made).not.toBe('mine');
    expect(ids()).toEqual(['mine', made]);
  });
});

describe('toast dismiss', () => {
  it('dismisses one toast, or all of them without an id', () => {
    store.show('error', 'a', { id: 'a' });
    store.show('error', 'b', { id: 'b' });
    store.show('error', 'c', { id: 'c' });
    store.show('error', 'd', { id: 'd' });
    store.dismiss('a');
    expect(ids()).toEqual(['b', 'c', 'd']);
    store.dismiss();
    expect(ids()).toEqual([]);
    expect(store.getSnapshot().queued).toBe(0);
  });

  it('ignores an id that is not there and does not notify', () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.dismiss('missing');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('toast pause', () => {
  it('holds the timer while the pointer is on the toast and resumes with the time left', () => {
    store.show('success', 'Saved', { id: 'a' });
    vi.advanceTimersByTime(3000);
    store.hold('a', 'pointer');
    expect(store.getSnapshot().visible[0]?.paused).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(ids()).toEqual(['a']);
    store.release('a', 'pointer');
    expect(store.getSnapshot().visible[0]?.paused).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(ids()).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it('stays held until both the pointer and the focus have left', () => {
    store.show('success', 'Saved', { id: 'a' });
    store.hold('a', 'pointer');
    store.hold('a', 'focus');
    store.release('a', 'pointer');
    vi.advanceTimersByTime(60000);
    expect(ids()).toEqual(['a']);
    store.release('a', 'focus');
    vi.advanceTimersByTime(5000);
    expect(ids()).toEqual([]);
  });

  it('holds every timer while the tab is hidden', () => {
    store.show('success', 'a', { id: 'a' });
    store.show('info', 'b', { id: 'b' });
    vi.advanceTimersByTime(2000);
    store.setHidden(true);
    expect(store.getSnapshot().visible.every((item) => item.paused)).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(ids()).toEqual(['a', 'b']);
    store.setHidden(false);
    vi.advanceTimersByTime(3000);
    expect(ids()).toEqual(['b']);
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual([]);
  });

  it('keeps a hold when the toast is replaced, but restarts the time', () => {
    store.show('success', 'one', { id: 'a' });
    store.hold('a', 'pointer');
    store.show('success', 'two', { id: 'a' });
    vi.advanceTimersByTime(60000);
    expect(ids()).toEqual(['a']);
    store.release('a', 'pointer');
    vi.advanceTimersByTime(5000);
    expect(ids()).toEqual([]);
  });
});

describe('toast promise', () => {
  it('shows a loading toast without a timer, then the result with its own time', async () => {
    let resolve!: (value: number) => void;
    const work = new Promise<number>((done) => {
      resolve = done;
    });
    const returned = store.promise(work, {
      pending: 'Saving…',
      success: (n) => `Saved ${n}`,
      error: 'Not saved',
    });
    expect(returned).toBe(work);
    expect(store.getSnapshot().visible[0]).toMatchObject({ type: 'loading', text: 'Saving…' });
    vi.advanceTimersByTime(60000);
    expect(store.getSnapshot().visible).toHaveLength(1);
    const id = ids()[0];
    resolve(3);
    await work;
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual([id]);
    expect(store.getSnapshot().visible[0]).toMatchObject({ type: 'success', text: 'Saved 3' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ids()).toEqual([]);
  });

  it('turns into a sticky error when the promise rejects', async () => {
    const work = Promise.reject(new Error('boom'));
    work.catch(() => undefined);
    void store.promise(work, {
      pending: 'Saving…',
      success: 'Saved',
      error: (reason) => `Failed: ${(reason as Error).message}`,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().visible[0]).toMatchObject({ type: 'error', text: 'Failed: boom' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(ids()).toHaveLength(1);
  });

  it('shows the result again if the loading toast was closed meanwhile', async () => {
    let resolve!: () => void;
    const work = new Promise<void>((done) => {
      resolve = done;
    });
    void store.promise(
      work,
      { pending: 'Saving…', success: 'Saved', error: 'Failed' },
      { id: 'p' },
    );
    store.dismiss('p');
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().visible[0]).toMatchObject({ id: 'p', type: 'success' });
  });
});

describe('toast subscription', () => {
  it('notifies listeners with a new snapshot on each change, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    const before = store.getSnapshot();
    store.show('info', 'x');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    stop();
    store.show('info', 'y');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
