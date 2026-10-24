// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AUTOPLAY_MS, Slider } from '../src/slider/slider.tsx';
import type { HeroSlide, SlideSet } from '../src/storefront/types.ts';

// The slider's behaviour, to the WAI-ARIA Authoring Practices carousel: markup that works without
// script, controls added by the script, autoplay that stops and never restarts against the buyer.

const slide = (n: number, over: Partial<HeroSlide> = {}): HeroSlide => ({
  id: `s${n}`,
  title: `Slide ${n} title`,
  body: `Slide ${n} body`,
  ctaLabel: `Go ${n}`,
  href: `/offers/${n}`,
  image: { src: `/placeholders/fruits.jpg`, alt: `Picture ${n}`, decorative: false },
  placement: 'start',
  tone: 'dark',
  sponsored: false,
  ...over,
});
const set = (count: number, over: Partial<SlideSet> = {}): SlideSet => ({
  position: 'home.hero',
  autoplay: true,
  slides: Array.from({ length: count }, (_, i) => slide(i + 1)),
  ...over,
});

let reduced = false;
const scrollBy = vi.fn();

beforeEach(() => {
  reduced = false;
  scrollBy.mockClear();
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduced-motion') ? reduced : false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollBy = scrollBy as never;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

const wrap = (node: React.ReactNode, dir?: 'rtl') => (
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    {dir === undefined ? node : <div dir={dir}>{node}</div>}
  </NextIntlClientProvider>
);
const show = (value: SlideSet, dir?: 'rtl') =>
  render(wrap(<Slider set={value} label="Featured" />, dir));
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const slides = () => screen.getAllByRole('group', { name: /^\d+ of \d+$/u });
const current = () => slides().findIndex((s) => !s.hasAttribute('inert'));
const track = () => document.querySelector('.slider-track') as HTMLElement;

describe('slides and their markup', () => {
  it('draws nothing for no slides', () => {
    const { container } = show(set(0));
    expect(container.innerHTML).toBe('');
  });

  it('draws one slide with no controls and no carousel semantics', () => {
    const { container } = show(set(1));
    expect(screen.getByRole('region', { name: 'Featured' })).toBeTruthy();
    expect(container.querySelector('[aria-roledescription]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Slide 1 title' })).toBeTruthy();
  });

  it('makes the whole slide one link: image, text and button label inside it', () => {
    show(set(1));
    const link = screen.getByRole('link', { name: 'Slide 1 title' });
    expect(link.getAttribute('href')).toBe('/offers/1');
    expect(link.querySelector('img')).not.toBeNull();
    expect(link.textContent).toContain('Slide 1 body');
    expect(link.textContent).toContain('Go 1');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('draws a slide with no link as plain text', () => {
    const { container } = show(
      set(1, { slides: [slide(1, { href: undefined, ctaLabel: undefined })] }),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toContain('Slide 1 title');
  });

  it('is a carousel region with a label, and each slide says "n of total"', () => {
    show(set(5));
    const region = screen.getByRole('region', { name: 'Featured' });
    expect(region.getAttribute('aria-roledescription')).toBe('carousel');
    expect(slides().map((s) => s.getAttribute('aria-label'))).toEqual([
      '1 of 5',
      '2 of 5',
      '3 of 5',
      '4 of 5',
      '5 of 5',
    ]);
    for (const s of slides()) expect(s.getAttribute('aria-roledescription')).toBe('slide');
  });

  it('loads only the first image eagerly', () => {
    show(set(3));
    const images = Array.from(document.querySelectorAll('img'));
    expect(images.map((i) => i.getAttribute('loading'))).toEqual(['eager', 'lazy', 'lazy']);
    expect(images[0]?.getAttribute('fetchpriority')).toBe('high');
  });

  it('shows the image alt text, and nothing for a decorative image', () => {
    show(
      set(2, {
        slides: [
          slide(1),
          slide(2, { image: { src: '/placeholders/egg.jpg', alt: '', decorative: true } }),
        ],
      }),
    );
    expect(document.querySelectorAll('img')[0]?.getAttribute('alt')).toBe('Picture 1');
    expect(document.querySelectorAll('img')[1]?.getAttribute('alt')).toBe('');
  });

  it('labels a sponsored slide', () => {
    show(set(2, { slides: [slide(1, { sponsored: true }), slide(2)] }));
    expect(screen.getAllByText('Sponsored')).toHaveLength(1);
  });

  it('renders every text as text, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = show(
      set(1, {
        slides: [
          slide(1, {
            title: hostile,
            body: hostile,
            ctaLabel: hostile,
            image: { src: '/placeholders/egg.jpg', alt: hostile, decorative: false },
          }),
        ],
      }),
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe(hostile);
  });

  it('marks the language of each text as its own (Persian over an English page)', () => {
    show(set(1, { slides: [slide(1, { title: 'گوشت تازه', body: 'حلال و تازه' })] }));
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('dir')).toBe('auto');
  });
});

describe('without script', () => {
  it('server-renders every slide, scrollable, with no controls and nothing hidden', () => {
    const html = renderToString(wrap(<Slider set={set(3)} label="Featured" />));
    expect(html.match(/aria-roledescription="slide"/gu)).toHaveLength(3);
    expect(html).toContain('class="slider-track"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('inert');
    expect(html).not.toContain('data-ready');
    // The first slide is first in the page; the others follow in the same track.
    expect(html.indexOf('Slide 1 title')).toBeLessThan(html.indexOf('Slide 2 title'));
  });
});

describe('controls', () => {
  it('adds the pause button first, then previous, next and one picker button per slide', () => {
    show(set(3));
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual([
      'Pause slideshow',
      'Previous slide',
      'Next slide',
      'Show slide 1 of 3',
      'Show slide 2 of 3',
      'Show slide 3 of 3',
    ]);
    // The controls come before the slides in the page, so they are first in the tab order.
    const first = screen.getByRole('button', { name: 'Pause slideshow' });
    expect(
      first.compareDocumentPosition(slides()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('makes the slides out of view inert and the one in view not', () => {
    show(set(3));
    expect(slides().map((s) => s.hasAttribute('inert'))).toEqual([false, true, true]);
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(slides().map((s) => s.hasAttribute('inert'))).toEqual([true, false, true]);
  });

  it('goes next and previous, and wraps round', () => {
    show(set(3));
    const next = screen.getByRole('button', { name: 'Next slide' });
    const previous = screen.getByRole('button', { name: 'Previous slide' });
    fireEvent.click(next);
    expect(current()).toBe(1);
    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(current()).toBe(2);
    fireEvent.click(next);
    expect(current()).toBe(0);
  });

  it('scrolls the track to the slide, smoothly for a step', () => {
    show(set(3));
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });

  it('jumps to a slide from the picker and marks it current', () => {
    show(set(4));
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 3 of 4' }));
    expect(current()).toBe(2);
    expect(
      screen.getByRole('button', { name: 'Show slide 3 of 4' }).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Show slide 1 of 4' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('keeps one picker button in the tab order and moves with the arrow keys', () => {
    show(set(4));
    const picker = screen.getByRole('group', { name: 'Choose a slide' });
    const dots = within(picker).getAllByRole('button');
    expect(dots.map((d) => d.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    fireEvent.keyDown(dots[0]!, { key: 'ArrowRight' });
    expect(current()).toBe(1);
    expect(document.activeElement).toBe(dots[1]);
    fireEvent.keyDown(dots[1]!, { key: 'End' });
    expect(current()).toBe(3);
    fireEvent.keyDown(dots[3]!, { key: 'ArrowLeft' });
    expect(current()).toBe(2);
    fireEvent.keyDown(dots[2]!, { key: 'Home' });
    expect(current()).toBe(0);
  });

  it('reverses the arrow keys of the picker in right-to-left text', () => {
    show(set(4), 'rtl');
    const dots = within(screen.getByRole('group', { name: 'Choose a slide' })).getAllByRole(
      'button',
    );
    fireEvent.keyDown(dots[0]!, { key: 'ArrowLeft' });
    expect(current()).toBe(1);
    fireEvent.keyDown(dots[1]!, { key: 'ArrowRight' });
    expect(current()).toBe(0);
  });

  it('follows the buyer when they scroll or swipe the track', () => {
    show(set(3));
    const slideEls = slides();
    const left = (el: Element) => (el === slideEls[2] ? 0 : el === track() ? 0 : 500);
    for (const el of [...slideEls, track()]) {
      el.getBoundingClientRect = () => ({ left: left(el) }) as DOMRect;
    }
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    fireEvent.scroll(track());
    vi.unstubAllGlobals();
    expect(current()).toBe(2);
  });
});

describe('autoplay', () => {
  it('never changes slide faster than every 6 seconds', () => {
    expect(AUTOPLAY_MS).toBeGreaterThanOrEqual(6000);
  });

  it('advances after the interval and keeps going, round to the first', () => {
    show(set(3));
    tick(AUTOPLAY_MS - 1);
    expect(current()).toBe(0);
    tick(1);
    expect(current()).toBe(1);
    tick(AUTOPLAY_MS);
    expect(current()).toBe(2);
    tick(AUTOPLAY_MS);
    expect(current()).toBe(0);
  });

  it('keeps aria-live off while it rotates and polite when it does not', () => {
    show(set(3));
    expect(track().getAttribute('aria-live')).toBe('off');
    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }));
    expect(track().getAttribute('aria-live')).toBe('polite');
  });

  it('stops while the pointer is over it and goes on when it leaves', () => {
    show(set(3));
    const region = screen.getByRole('region', { name: 'Featured' });
    fireEvent.mouseEnter(region);
    tick(AUTOPLAY_MS * 3);
    expect(current()).toBe(0);
    fireEvent.mouseLeave(region);
    tick(AUTOPLAY_MS);
    expect(current()).toBe(1);
  });

  it('stops while focus is inside and goes on when it leaves', () => {
    show(set(3));
    const next = screen.getByRole('button', { name: 'Next slide' });
    act(() => next.focus());
    tick(AUTOPLAY_MS * 3);
    expect(current()).toBe(0);
    act(() => next.blur());
    tick(AUTOPLAY_MS);
    expect(current()).toBe(1);
  });

  it('stops for good on touch', () => {
    show(set(3));
    const region = screen.getByRole('region', { name: 'Featured' });
    fireEvent.touchStart(region);
    tick(AUTOPLAY_MS * 3);
    expect(current()).toBe(0);
    expect(screen.getByRole('button', { name: 'Start slideshow' })).toBeTruthy();
  });

  it('stops while the tab is hidden and goes on when it is shown', () => {
    show(set(3));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    tick(AUTOPLAY_MS * 3);
    expect(current()).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    tick(AUTOPLAY_MS);
    expect(current()).toBe(1);
  });

  it('never restarts after the buyer pauses it, whatever the pointer or focus does', () => {
    show(set(3));
    const region = screen.getByRole('region', { name: 'Featured' });
    const pause = screen.getByRole('button', { name: 'Pause slideshow' });
    act(() => pause.focus());
    fireEvent.click(pause);
    fireEvent.mouseEnter(region);
    fireEvent.mouseLeave(region);
    act(() => pause.blur());
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    tick(AUTOPLAY_MS * 5);
    expect(current()).toBe(0);
  });

  it('starts again only when the buyer presses play', () => {
    show(set(3));
    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }));
    tick(AUTOPLAY_MS * 2);
    expect(current()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Start slideshow' }));
    expect(screen.getByRole('button', { name: 'Pause slideshow' })).toBeTruthy();
    tick(AUTOPLAY_MS);
    expect(current()).toBe(1);
  });

  it('lets the buyer move on by hand while it is paused, and the timer waits', () => {
    show(set(3));
    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    tick(AUTOPLAY_MS * 2);
    expect(current()).toBe(1);
  });

  it('does not autoplay with reduced motion, has no pause button, and scrolls without smoothing', () => {
    reduced = true;
    show(set(3));
    expect(screen.queryByRole('button', { name: 'Pause slideshow' })).toBeNull();
    tick(AUTOPLAY_MS * 3);
    expect(current()).toBe(0);
    expect(track().getAttribute('aria-live')).toBe('polite');
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it('does not autoplay at a position that does not allow it', () => {
    show(set(3, { position: 'home.mid', autoplay: false }));
    expect(screen.queryByRole('button', { name: 'Pause slideshow' })).toBeNull();
    tick(AUTOPLAY_MS * 3);
    expect(current()).toBe(0);
    expect(track().getAttribute('aria-live')).toBe('polite');
  });
});

describe('right to left', () => {
  it('flips the arrows with CSS and keeps previous before next in the page order', () => {
    show(set(3), 'rtl');
    const previous = screen.getByRole('button', { name: 'Previous slide' });
    const next = screen.getByRole('button', { name: 'Next slide' });
    // Source order is previous, next; the row flows from the right in right-to-left text.
    expect(previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previous.querySelector('.slider-arrow')).not.toBeNull();
  });
});
