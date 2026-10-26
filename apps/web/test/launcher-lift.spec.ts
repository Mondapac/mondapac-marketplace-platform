import { describe, expect, it } from 'vitest';
import { LAUNCHER_REST, launcherHidden, launcherLift } from '../src/assistant/launcher-lift.ts';

const HEIGHT = 667;
// 375x667 with a tab bar of 65px, and a bar sticking 13px above it (as the buy bar does).
const TAB_BAR = { top: 602, bottom: 667 };
const STUCK_BAR = { top: 522, bottom: 589 };

describe('launcherLift', () => {
  it('rests 20px from the bottom with no dock', () => {
    expect(launcherLift(HEIGHT, null, [], null)).toEqual({
      dock: 0,
      lift: LAUNCHER_REST,
      alignBackToTop: false,
    });
  });

  it('sits 12px above the dock', () => {
    const { dock, lift } = launcherLift(HEIGHT, TAB_BAR, [], null);
    expect(dock).toBe(65);
    expect(lift).toBe(77);
  });

  it('goes above a buy bar stuck over the dock, and clears it', () => {
    const { lift } = launcherLift(HEIGHT, TAB_BAR, [STUCK_BAR], null);
    expect(lift).toBe(HEIGHT - STUCK_BAR.top + 12);
    const launcherBottom = HEIGHT - lift;
    expect(launcherBottom).toBeLessThanOrEqual(STUCK_BAR.top - 12);
  });

  it('goes above the dock and a cookie bar that makes the dock tall', () => {
    const tall = { top: 330, bottom: 667 };
    expect(launcherLift(HEIGHT, tall, [], null).lift).toBe(337 + 12);
  });

  it('ignores a bar that is not shown, or far above the launcher', () => {
    const far = { top: 100, bottom: 167 };
    expect(launcherLift(HEIGHT, TAB_BAR, [null, far], null).lift).toBe(77);
  });

  it('decides from the resting place, so the same scroll position gives the same lift', () => {
    const bar = { top: 480, bottom: 547 };
    const first = launcherLift(HEIGHT, TAB_BAR, [bar], null);
    const second = launcherLift(HEIGHT, TAB_BAR, [bar], null);
    expect(second).toEqual(first);
  });

  it('lifts above the back-to-top button at the end of the page and lines up with it', () => {
    const top = { top: 560, bottom: 608 };
    const lift = launcherLift(HEIGHT, null, [], top);
    expect(lift.alignBackToTop).toBe(true);
    expect(lift.lift).toBe(HEIGHT - 560 + 12);
  });

  it('leaves back-to-top alone while it is under the dock', () => {
    const hidden = { top: 640, bottom: 688 };
    expect(launcherLift(HEIGHT, TAB_BAR, [], hidden).alignBackToTop).toBe(false);
  });
});

describe('launcherHidden', () => {
  it('hides the launcher only on a phone with the cookie bar open', () => {
    expect(launcherHidden(true, true)).toBe(true);
    expect(launcherHidden(true, false)).toBe(false);
    expect(launcherHidden(false, true)).toBe(false);
    expect(launcherHidden(false, false)).toBe(false);
  });
});
