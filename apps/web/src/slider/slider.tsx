'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { HeroSlide, SlideSet } from '../storefront/types.ts';

// The buyer site's slider (storefront slider PR 2): plain text over an optional image, one internal
// link that makes the whole slide clickable. Server-rendered: every slide is in the page and the
// track scrolls sideways (CSS scroll-snap), so it works without JavaScript. With JavaScript it adds
// the controls, `inert` on the slides out of view, and, where the position allows, autoplay, built
// to the WAI-ARIA Authoring Practices carousel: a pause button first in the tab order, rotation
// stops while the pointer or focus is inside, on touch and while the tab is hidden, and never
// restarts after the buyer pauses it; reduced motion means no autoplay and no smooth scrolling.
// One slide draws no controls; no slides draw nothing.

/** How long a slide stays while autoplaying (milliseconds); never under 6 seconds. */
export const AUTOPLAY_MS = 7000;

const isRtl = (el: Element | null): boolean =>
  el !== null &&
  (getComputedStyle(el).direction === 'rtl' || el.closest('[dir]')?.getAttribute('dir') === 'rtl');

/** Only keyboard focus holds the rotation; a click that happens to focus a button does not. */
function keyboardFocus(target: Element): boolean {
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

function Chevron({ next }: { readonly next: boolean }) {
  return (
    <svg
      className="slider-arrow"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={next ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PauseIcon({ playing }: { readonly playing: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d={playing ? 'M8 5v14M16 5v14' : 'm8 5 11 7-11 7z'}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SlideView({
  slide,
  index,
  count,
  inert,
  id,
  panel,
}: {
  readonly slide: HeroSlide;
  readonly index: number;
  readonly count: number;
  readonly inert: boolean;
  readonly id: string;
  /** With the picker present each slide is the panel of its tab; without it, a plain group. */
  readonly panel: boolean;
}) {
  const t = useTranslations('slider');
  const uid = useId();
  const titleId = `${uid}t`;
  const tagId = `${uid}s`;
  const bodyId = `${uid}b`;
  const art = slide.image?.src.startsWith('/placeholders/') === true;
  const inside: ReactNode = (
    <>
      {slide.image === undefined ? null : (
        <img
          className={art ? 'slide-img art' : 'slide-img'}
          src={slide.image.src}
          alt={slide.image.alt}
          loading={index === 0 ? 'eager' : 'lazy'}
          fetchPriority={index === 0 ? 'high' : 'auto'}
          decoding="async"
          draggable={false}
        />
      )}
      <span className="slide-text">
        {slide.sponsored ? (
          <span id={tagId} className="slide-tag">
            {t('sponsored')}
          </span>
        ) : null}
        <h2 id={titleId} dir="auto">
          {slide.title}
        </h2>
        {slide.body === undefined ? null : (
          <p id={bodyId} dir="auto">
            {slide.body}
          </p>
        )}
        {slide.ctaLabel === undefined || slide.href === undefined ? null : (
          <span className="slide-cta" dir="auto">
            {slide.ctaLabel}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      id={id}
      className="slide"
      data-tone={slide.tone}
      data-placement={slide.placement}
      {...(count > 1
        ? {
            role: panel ? 'tabpanel' : 'group',
            'aria-roledescription': 'slide',
            'aria-label': t('slide-of', { n: index + 1, total: count }),
          }
        : {})}
      inert={inert}
    >
      {slide.href === undefined ? (
        <div className="slide-inner">{inside}</div>
      ) : (
        <Link
          className="slide-inner"
          href={slide.href}
          aria-labelledby={slide.sponsored ? `${tagId} ${titleId}` : titleId}
          aria-describedby={slide.body === undefined ? undefined : bodyId}
        >
          {inside}
        </Link>
      )}
    </div>
  );
}

function Carousel({ set, label }: { readonly set: SlideSet; readonly label: string }) {
  const t = useTranslations('slider');
  const { slides } = set;
  const count = slides.length;
  const base = useId();
  const rootRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLDivElement>(null);
  const lock = useRef<number>(0);
  const frame = useRef<number>(0);
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setReady(true);
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    const onMotion = () => setReduced(media?.matches === true);
    onMotion();
    media?.addEventListener('change', onMotion);
    const onVisibility = () => setHidden(document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      media?.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const goTo = useCallback(
    (raw: number, smooth: boolean) => {
      const next = (raw + count) % count;
      setCurrent(next);
      // While the programmatic scroll runs, the scroll handler must not read the slide it passes.
      lock.current = Date.now() + 800;
      const track = trackRef.current;
      const slide = track?.children[next] as HTMLElement | undefined;
      if (track === null || slide === undefined || typeof track.scrollBy !== 'function') return;
      const delta = slide.getBoundingClientRect().left - track.getBoundingClientRect().left;
      track.scrollBy({ left: delta, behavior: smooth && !reduced ? 'smooth' : 'auto' });
    },
    [count, reduced],
  );

  // The slide nearest the start edge of the track is the current one (the buyer scrolled or swiped).
  const readScroll = useCallback(() => {
    const track = trackRef.current;
    if (track === null || Date.now() < lock.current) return;
    const edge = track.getBoundingClientRect().left;
    let nearest = 0;
    let best = Infinity;
    Array.from(track.children).forEach((slide, i) => {
      const gap = Math.abs(slide.getBoundingClientRect().left - edge);
      if (gap < best) {
        best = gap;
        nearest = i;
      }
    });
    setCurrent(nearest);
  }, []);

  const onScroll = () => {
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      readScroll();
    });
  };

  // Autoplay: only where the position allows it, never with reduced motion, and never again once
  // the buyer has paused it (or touched the slider). The timer is held, not ended, while the
  // pointer or focus is inside or the tab is hidden.
  const autoplay = ready && set.autoplay && !reduced;
  const running = autoplay && !paused && !hovered && !focused && !hidden;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => goTo(current + 1, current + 1 < count), AUTOPLAY_MS);
    return () => clearTimeout(timer);
  }, [running, current, count, goTo]);

  const slideId = (i: number) => `${base}-slide-${i}`;

  const onDotKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = isRtl(rootRef.current) ? 'ArrowRight' : 'ArrowLeft';
    const forward = back === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    let target: number | null = null;
    if (event.key === forward) target = Math.min(current + 1, count - 1);
    else if (event.key === back) target = Math.max(current - 1, 0);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = count - 1;
    if (target === null) return;
    event.preventDefault();
    goTo(target, true);
    (dotsRef.current?.children[target] as HTMLElement | undefined)?.focus();
  };

  return (
    <section
      ref={rootRef}
      className="slider"
      data-position={set.position}
      data-count={count}
      data-ready={ready ? '' : undefined}
      aria-roledescription="carousel"
      aria-label={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => setFocused(keyboardFocus(event.target))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onTouchStart={() => setPaused(true)}
    >
      <div className="slider-controls">
        {ready ? (
          <>
            {autoplay ? (
              <button
                type="button"
                className="slider-btn"
                aria-label={paused ? t('play') : t('pause')}
                onClick={() => setPaused((was) => !was)}
              >
                <PauseIcon playing={!paused} />
              </button>
            ) : null}
            <button
              type="button"
              className="slider-btn"
              aria-label={t('previous')}
              onClick={() => goTo(current - 1, true)}
            >
              <Chevron next={false} />
            </button>
            <button
              type="button"
              className="slider-btn"
              aria-label={t('next')}
              onClick={() => goTo(current + 1, true)}
            >
              <Chevron next />
            </button>
            <div
              ref={dotsRef}
              className="slider-dots"
              role="tablist"
              aria-label={t('choose')}
              onKeyDown={onDotKey}
            >
              {slides.map((slide, i) => (
                <button
                  key={slide.id}
                  type="button"
                  className="slider-dot"
                  role="tab"
                  tabIndex={i === current ? 0 : -1}
                  aria-label={t('go-to', { n: i + 1, total: count })}
                  aria-selected={i === current}
                  aria-controls={slideId(i)}
                  onClick={() => goTo(i, true)}
                >
                  <span aria-hidden="true" />
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div
        ref={trackRef}
        className="slider-track"
        aria-live={running ? 'off' : 'polite'}
        onScroll={onScroll}
        onScrollEnd={() => {
          lock.current = 0;
          readScroll();
        }}
      >
        {slides.map((slide, i) => (
          <SlideView
            key={slide.id}
            slide={slide}
            index={i}
            count={count}
            inert={ready && i !== current}
            id={slideId(i)}
            panel={ready}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The slider of one position. `label` names the region (the caller's wording in the buyer's
 * language); the slides' texts are the content's own.
 */
export function Slider({ set, label }: { readonly set: SlideSet; readonly label: string }) {
  if (set.slides.length === 0) return null;
  if (set.slides.length === 1) {
    return (
      <section className="slider" data-position={set.position} data-count="1" aria-label={label}>
        <div className="slider-track">
          <SlideView
            slide={set.slides[0]!}
            index={0}
            count={1}
            inert={false}
            id="slide-0"
            panel={false}
          />
        </div>
      </section>
    );
  }
  return <Carousel set={set} label={label} />;
}
