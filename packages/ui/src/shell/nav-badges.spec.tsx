// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NavBadgePill,
  NavBadgeProvider,
  badgeText,
  sumBadges,
  useNavBadges,
  useSetNavBadge,
  type NavBadgeValue,
} from './nav-badges.tsx';

afterEach(cleanup);

const value = (count: number, tone: NavBadgeValue['tone'] = 'info'): NavBadgeValue => ({
  count,
  tone,
  label: `${count} waiting`,
});

describe('badge text', () => {
  it('writes the number up to 99 and 99+ above it', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('NavBadgePill', () => {
  it('is hidden from screen readers, which get the item label instead', () => {
    render(<NavBadgePill count={120} tone="critical" />);
    const pill = screen.getByText('99+');
    expect(pill.getAttribute('aria-hidden')).toBe('true');
    expect(pill.className).toContain('text-critical-fg');
  });
});

describe('sumBadges', () => {
  it('adds the counts of the sources that have one and says nothing for none', () => {
    const badges = { a: value(2), b: value(3, 'critical') };
    expect(sumBadges(['a', 'b', 'c', undefined], badges)).toMatchObject({
      count: 5,
      tone: 'critical',
    });
    expect(sumBadges(['c'], badges)).toBeNull();
    expect(sumBadges(['a'], { a: value(0) })).toBeNull();
  });
});

describe('NavBadgeProvider', () => {
  function Probe() {
    const badges = useNavBadges();
    const set = useSetNavBadge();
    return (
      <div>
        <output>{badges['x']?.count ?? 'none'}</output>
        <button type="button" onClick={() => set('x', value(4))}>
          set
        </button>
        <button type="button" onClick={() => set('x', null)}>
          clear
        </button>
      </div>
    );
  }

  it('keeps what a source reports and forgets it when the source clears', () => {
    render(
      <NavBadgeProvider>
        <Probe />
      </NavBadgeProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('none');
    act(() => screen.getByRole('button', { name: 'set' }).click());
    expect(screen.getByRole('status').textContent).toBe('4');
    act(() => screen.getByRole('button', { name: 'clear' }).click());
    expect(screen.getByRole('status').textContent).toBe('none');
  });
});
