// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSectionSaves, type SaveSection, type SectionResult } from './use-section-saves.ts';

const section = (key: string, dirty: boolean, result: SectionResult = 'saved'): SaveSection => ({
  key,
  dirty,
  save: vi.fn(() => Promise.resolve(result)),
});

describe('useSectionSaves', () => {
  it('counts the dirty sections', () => {
    const { result } = renderHook(() =>
      useSectionSaves([section('a', true), section('b', false), section('c', true)]),
    );
    expect(result.current.count).toBe(2);
    expect(result.current.saving).toBe(false);
  });

  it('saves only the dirty sections, in order, and keeps going after a failure', async () => {
    const order: string[] = [];
    const tracked = (key: string, dirty: boolean, outcome: SectionResult): SaveSection => ({
      key,
      dirty,
      save: () => {
        order.push(key);
        return Promise.resolve(outcome);
      },
    });
    const { result } = renderHook(() =>
      useSectionSaves([
        tracked('a', true, 'failed'),
        tracked('b', false, 'saved'),
        tracked('c', true, 'saved'),
      ]),
    );
    let run: Awaited<ReturnType<typeof result.current.saveAll>> = null;
    await act(async () => {
      run = await result.current.saveAll();
    });
    expect(order).toEqual(['a', 'c']);
    expect(run).toEqual({ saved: ['c'], failed: ['a'], stopped: false });
    expect(result.current.saving).toBe(false);
  });

  it('stops the run at a stopped section and sends nothing after it', async () => {
    const last = section('c', true);
    const { result } = renderHook(() =>
      useSectionSaves([section('a', true), section('b', true, 'stopped'), last]),
    );
    let run: Awaited<ReturnType<typeof result.current.saveAll>> = null;
    await act(async () => {
      run = await result.current.saveAll();
    });
    expect(run).toEqual({ saved: ['a'], failed: [], stopped: true });
    expect(last.save).not.toHaveBeenCalled();
  });

  it('sends nothing for a second call while a run is going', async () => {
    let finish: (value: SectionResult) => void = () => undefined;
    const slow: SaveSection = {
      key: 'a',
      dirty: true,
      save: vi.fn(
        () =>
          new Promise<SectionResult>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const { result } = renderHook(() => useSectionSaves([slow]));
    let first: Promise<unknown> = Promise.resolve();
    let second: unknown;
    await act(async () => {
      first = result.current.saveAll();
      second = await result.current.saveAll();
    });
    expect(second).toBeNull();
    expect(result.current.saving).toBe(true);
    await act(async () => {
      finish('saved');
      await first;
    });
    expect(slow.save).toHaveBeenCalledTimes(1);
    expect(result.current.saving).toBe(false);
  });
});
