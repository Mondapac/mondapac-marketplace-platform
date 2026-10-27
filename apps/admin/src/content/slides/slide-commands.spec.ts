import { describe, expect, it } from 'vitest';
import { findingsOf, isStale, messageOf } from './slide-commands.ts';
import type { SlidePlacement } from './slide-types.ts';

const failure = (code: string, status = 409, fields?: { path: string; code: string }[]) => ({
  status,
  code,
  ...(fields === undefined ? {} : { details: { fields } }),
});
const placement = (position: string): SlidePlacement => ({
  position,
  scope: 'all',
  scopeId: null,
  includeSubcategories: false,
  sortOrder: 0,
  autoplay: false,
});

describe('messageOf', () => {
  it.each([
    ['storefront.slide-not-found', 'not-found'],
    ['storefront.slide-version-not-found', 'version-not-found'],
    ['storefront.slide-archived', 'archived'],
    ['storefront.slide-version-limit', 'version-limit'],
    ['storefront.slide-no-draft', 'no-draft'],
    ['storefront.slide-draft-changed', 'draft-changed'],
    ['storefront.slide-not-submitted', 'not-submitted'],
    ['storefront.slide-ended', 'ended'],
    ['storefront.slide-not-live', 'not-live'],
    ['storefront.slide-not-paused', 'not-paused'],
    ['storefront.slide-position-full', 'position-full'],
    ['storefront.slide-link-invalid', 'link-invalid'],
    ['validation.failed', 'invalid'],
  ])('reads %s as %s', (code, message) => {
    expect(messageOf(failure(code))).toBe(message);
  });

  it('reads a lost connection, a refusal by status and anything else', () => {
    expect(messageOf({ status: 0, code: 'network' })).toBe('network');
    expect(messageOf(failure('access.denied', 403))).toBe('denied');
    expect(messageOf(failure('request.csrf', 403))).toBe('denied');
    expect(messageOf(failure('unknown', 500))).toBe('generic');
    expect(messageOf(failure('something.new', 418))).toBe('generic');
  });
});

describe('isStale', () => {
  it('is true for the answers that mean the slide changed meanwhile', () => {
    for (const code of [
      'storefront.slide-not-found',
      'storefront.slide-archived',
      'storefront.slide-no-draft',
      'storefront.slide-draft-changed',
      'storefront.slide-not-submitted',
      'storefront.slide-ended',
      'storefront.slide-not-live',
      'storefront.slide-not-paused',
    ]) {
      expect(isStale(messageOf(failure(code))), code).toBe(true);
    }
  });
  it('is false for a refusal the admin can answer by trying again or fixing something', () => {
    for (const code of [
      'storefront.slide-position-full',
      'storefront.slide-link-invalid',
      'storefront.slide-version-limit',
      'validation.failed',
      'unknown',
    ]) {
      expect(isStale(messageOf(failure(code, 409))), code).toBe(false);
    }
    expect(isStale(messageOf({ status: 0, code: 'network' }))).toBe(false);
  });
});

describe('findingsOf', () => {
  const placements = [placement('home.hero'), placement('category.top')];

  it('reads a bad link, a bad scope and a full position, each against its placement', () => {
    const found = findingsOf(
      failure('storefront.slide-link-invalid', 409, [
        { path: 'content.link', code: 'not-found' },
        { path: 'placements[1].scopeId', code: 'not-found' },
        { path: 'placements[0].position', code: 'full' },
      ]),
      placements,
    );
    expect(found).toEqual([
      { kind: 'link', placement: null },
      { kind: 'scope', placement: placements[1] },
      { kind: 'full', placement: placements[0] },
    ]);
  });

  it('keeps a finding whose placement is not known, and ignores a path it does not know', () => {
    const found = findingsOf(
      failure('storefront.slide-position-full', 409, [
        { path: 'placements[5].position', code: 'full' },
        { path: 'somewhere.else', code: 'x' },
      ]),
      placements,
    );
    expect(found).toEqual([{ kind: 'full', placement: null }]);
  });

  it('has none when the answer carries no fields', () => {
    expect(findingsOf(failure('storefront.slide-ended'), placements)).toEqual([]);
  });
});
