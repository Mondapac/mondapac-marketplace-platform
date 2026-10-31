// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { useSettingsForm, type FieldChange, type RunResult, type SaveResult } from '@mondapac/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Saved {
  readonly version: number;
  readonly title: string;
}

const toDraft = (saved: Saved) => saved.title;
const versionOf = (saved: Saved) => saved.version;
const changes = (saved: Saved, draft: string): readonly FieldChange[] =>
  draft === saved.title ? [] : [{ key: 'title', label: 'Title', saved: saved.title, yours: draft }];

const mount = (initial: Saved, reload: () => Promise<Saved | null>) =>
  renderHook(() =>
    useSettingsForm<Saved, string>({ initial, toDraft, versionOf, changes, reload }),
  );
const nothing = () => Promise.resolve(null);
const answer = (result: SaveResult<Saved>) =>
  vi.fn<(version: number) => Promise<SaveResult<Saved>>>(() => Promise.resolve(result));

afterEach(cleanup);

describe('useSettingsForm', () => {
  it('counts changed fields against the saved value and discards back to it', () => {
    const { result } = mount({ version: 1, title: 'A' }, nothing);
    expect(result.current.count).toBe(0);
    act(() => result.current.setDraft('B'));
    expect(result.current.count).toBe(1);
    expect(result.current.dirty).toBe(true);
    act(() => result.current.discard());
    expect(result.current.draft).toBe('A');
    expect(result.current.dirty).toBe(false);
  });

  it('sends the saved version, then adopts the answer as baseline and draft', async () => {
    const { result } = mount({ version: 1, title: 'A' }, nothing);
    act(() => result.current.setDraft('B'));
    const write = answer({ status: 'saved', saved: { version: 2, title: 'B' } });
    await act(async () => {
      await result.current.run(write);
    });
    expect(write).toHaveBeenCalledWith(1);
    expect(result.current.saved).toEqual({ version: 2, title: 'B' });
    expect(result.current.dirty).toBe(false);
    expect(result.current.theirs).toBeNull();
  });

  it('keeps the draft on a conflict, exposes theirs, and the next write carries the new version', async () => {
    const reload = vi.fn(() => Promise.resolve({ version: 5, title: 'Theirs' }));
    const { result } = mount({ version: 1, title: 'A' }, reload);
    act(() => result.current.setDraft('Mine'));

    let outcome: RunResult<Saved> | undefined;
    await act(async () => {
      outcome = await result.current.run(answer({ status: 'conflict' }));
    });
    expect(outcome).toEqual({ status: 'conflict', reloaded: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe('Mine');
    expect(result.current.theirs).toEqual({ version: 5, title: 'Theirs' });
    expect(result.current.conflictId).toBe(1);
    // Measured against what is saved now: saved now / yours.
    expect(result.current.changes).toEqual([
      { key: 'title', label: 'Title', saved: 'Theirs', yours: 'Mine' },
    ]);

    const write = answer({ status: 'saved', saved: { version: 6, title: 'Mine' } });
    await act(async () => {
      await result.current.run(write);
    });
    expect(write).toHaveBeenCalledWith(5);
    expect(result.current.theirs).toBeNull();
  });

  it('reports a conflict whose re-read failed, without theirs', async () => {
    const { result } = mount({ version: 1, title: 'A' }, nothing);
    act(() => result.current.setDraft('Mine'));
    let outcome: RunResult<Saved> | undefined;
    await act(async () => {
      outcome = await result.current.run(answer({ status: 'conflict' }));
    });
    expect(outcome).toEqual({ status: 'conflict', reloaded: false });
    expect(result.current.theirs).toBeNull();
    expect(result.current.draft).toBe('Mine');
  });

  it('runs one write at a time', async () => {
    const { result } = mount({ version: 1, title: 'A' }, nothing);
    let release: (value: SaveResult<Saved>) => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<SaveResult<Saved>>((resolve) => {
          release = resolve;
        }),
    );
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.run(slow);
    });
    const second = answer({ status: 'failed' });
    await act(async () => {
      await result.current.run(second);
    });
    expect(second).not.toHaveBeenCalled();
    await act(async () => {
      release({ status: 'failed' });
      await first;
    });
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
