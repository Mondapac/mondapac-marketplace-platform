import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE,
  PAGE_SIZE,
  cursorOf,
  openTotal,
  pageCountOf,
  pageOfStack,
  stepStack,
} from './cursor-paging.ts';

describe('page numbers', () => {
  it('counts the pages of a total and stops at the API depth limit (row 10,000)', () => {
    expect(pageCountOf(0)).toBe(1);
    expect(pageCountOf(25)).toBe(1);
    expect(pageCountOf(26)).toBe(2);
    expect(pageCountOf(10_000)).toBe(400);
    expect(pageCountOf(1_000_000)).toBe(MAX_PAGE);
    expect(MAX_PAGE * PAGE_SIZE).toBe(10_000);
  });
});

describe('the cursor stack', () => {
  it('starts on page 1 with no cursor', () => {
    expect(pageOfStack([])).toBe(1);
    expect(cursorOf([])).toBeNull();
  });

  it('goes one page on with the cursor the answer gave, and one back by dropping it', () => {
    const second = stepStack([], 2, 'c1');
    expect(second).toEqual(['c1']);
    expect(pageOfStack(second)).toBe(2);
    expect(cursorOf(second)).toBe('c1');
    const third = stepStack(second, 3, 'c2');
    expect(third).toEqual(['c1', 'c2']);
    expect(stepStack(third, 2, null)).toEqual(['c1']);
    expect(stepStack(['c1'], 1, null)).toEqual([]);
  });

  it('stays where it is for a step with no cursor to follow, or a jump', () => {
    expect(stepStack([], 2, null)).toEqual([]);
    expect(stepStack(['c1'], 5, 'c9')).toEqual(['c1']);
  });
});

describe('openTotal', () => {
  it('is one row past the page while another follows, so Next knows where the end is', () => {
    expect(openTotal(1, 25, true)).toBe(26);
    expect(openTotal(3, 25, true)).toBe(76);
  });

  it('is the rows seen on the last page', () => {
    expect(openTotal(3, 7, false)).toBe(57);
    expect(openTotal(1, 25, false)).toBe(25);
  });
});
