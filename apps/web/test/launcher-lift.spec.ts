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

import { dockForLauncher, movingBarBox } from '../src/assistant/launcher-lift.ts';

describe('launcher with the tab bar sliding away (product page)', () => {
  // 375x667: the buy bar stuck over the tab bar, or dropped to the bottom edge when it is away.
  const SHOWN_BAR = { top: 522, bottom: 589 };
  const AWAY_BAR = { top: 586, bottom: 653 };

  it('sits above the tab bar and the buy bar while the tab bar is shown', () => {
    const { lift } = launcherLift(
      HEIGHT,
      dockForLauncher(TAB_BAR, false, false),
      [SHOWN_BAR],
      null,
    );
    expect(lift).toBe(HEIGHT - SHOWN_BAR.top + 12);
  });

  it('comes down above the buy bar once the tab bar is away and settled', () => {
    const { dock, lift } = launcherLift(
      HEIGHT,
      dockForLauncher(TAB_BAR, true, false),
      [AWAY_BAR],
      null,
    );
    expect(dock).toBe(0);
    expect(lift).toBe(HEIGHT - AWAY_BAR.top + 12);
    expect(HEIGHT - lift).toBeLessThanOrEqual(AWAY_BAR.top - 12);
  });

  it('keeps the shown, higher geometry while the bars move, so it never overlaps them', () => {
    // Halfway through the slide the buy bar is 30px below its stuck place; the launcher decides
    // from the stuck place above the shown tab bar (65px tall, 13px gap), the higher one.
    const midway = { top: SHOWN_BAR.top + 30, bottom: SHOWN_BAR.bottom + 30 };
    const bar = movingBarBox(midway, HEIGHT, 65, 13);
    // The union of where it is and where it stands stuck above the shown tab bar.
    expect(bar).toEqual({ top: HEIGHT - 65 - 13 - 67, bottom: midway.bottom });
    const moving = launcherLift(HEIGHT, dockForLauncher(TAB_BAR, true, true), [bar], null);
    const shown = launcherLift(HEIGHT, TAB_BAR, [SHOWN_BAR], null);
    expect(moving.lift).toBe(shown.lift);
    expect(moving.lift).toBeGreaterThan(launcherLift(HEIGHT, null, [AWAY_BAR], null).lift);
    // At no point in the slide does the bar rise above the launcher's place.
    for (let dy = 0; dy <= 64; dy += 8) {
      const at = { top: SHOWN_BAR.top + dy, bottom: SHOWN_BAR.bottom + dy };
      expect(HEIGHT - moving.lift).toBeLessThanOrEqual(at.top);
    }
  });

  it('keeps a released bar and its place when it is not on screen', () => {
    expect(movingBarBox(null, HEIGHT, 65, 13)).toBeNull();
    const released = { top: 300, bottom: 367 };
    expect(movingBarBox(released, HEIGHT, 65, 13)?.top).toBe(300);
  });

  it('with the cookie bar open the tab bar stays, the dock is tall and the launcher hides on a phone', () => {
    const tall = { top: 330, bottom: 667 };
    expect(dockForLauncher(tall, false, false)).toBe(tall);
    expect(launcherLift(HEIGHT, tall, [SHOWN_BAR], null).lift).toBeGreaterThanOrEqual(
      HEIGHT - tall.top + 12,
    );
    expect(launcherHidden(true, true)).toBe(true);
    expect(launcherHidden(false, true)).toBe(false);
  });
});
