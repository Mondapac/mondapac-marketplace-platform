import { describe, expect, it } from 'vitest';
import {
  isRtl,
  nameOf,
  orderedLocales,
  parentOptions,
  proposalProblemOf,
  shelfProblemOf,
  textsBody,
} from './logic.ts';

describe('category proposal logic', () => {
  it('reads Persian and Arabic right to left, and English left to right', () => {
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('ar-AE')).toBe(true);
    expect(isRtl('en-AU')).toBe(false);
  });

  it('puts the default locale first and keeps the rest once', () => {
    expect(orderedLocales({ default: 'en-AU', supported: ['fa', 'en-AU', 'ar'] })).toEqual([
      'en-AU',
      'fa',
      'ar',
    ]);
  });

  it('sends only filled locales and leaves out a blank description', () => {
    expect(
      textsBody({
        'en-AU': { name: ' Sweets ', shortDescription: ' ' },
        fa: { name: '', shortDescription: 'x' },
        ar: { name: 'حلويات', shortDescription: 'd' },
      }),
    ).toEqual({ 'en-AU': { name: 'Sweets' }, ar: { name: 'حلويات', shortDescription: 'd' } });
  });

  it('labels parents with their path, sorted', () => {
    const options = parentOptions(
      [
        { categoryId: 'b', parentId: 'a', names: { 'en-AU': 'Oils' } },
        { categoryId: 'a', parentId: null, names: { 'en-AU': 'Pantry' } },
      ],
      'en-AU',
    );
    expect(options).toEqual([
      { value: 'a', label: 'Pantry' },
      { value: 'b', label: 'Pantry / Oils' },
    ]);
  });

  it('names a proposal in the default locale, else the first', () => {
    const texts = [
      { locale: 'fa', name: 'شیرینی', description: null },
      { locale: 'en-AU', name: 'Sweets', description: null },
    ];
    expect(nameOf(texts, 'en-AU')).toBe('Sweets');
    expect(nameOf(texts.slice(0, 1), 'en-AU')).toBe('شیرینی');
    expect(nameOf([], 'en-AU')).toBeNull();
  });

  it.each([
    ['category-proposal.not-allowed', 403, 'not-allowed'],
    ['category-proposal.duplicate', 409, 'duplicate'],
    ['category-proposal.limit', 422, 'limit'],
    ['claim-text.check-unavailable', 503, 'check-unavailable'],
    ['request.throttled', 429, 'throttled'],
    ['conflict.stale', 409, 'stale'],
    ['something.new', 400, 'unknown'],
  ])('maps %s to copy', (code, status, form) => {
    expect(proposalProblemOf({ status, code }).form).toBe(form);
  });

  it('keeps the limit, and the field and kind of a refused word but never a word', () => {
    expect(
      proposalProblemOf({ status: 422, code: 'category-proposal.limit', details: { max: 5 } }).max,
    ).toBe(5);
    const problem = proposalProblemOf({
      status: 422,
      code: 'category.claim-word',
      details: { fields: [{ path: 'texts.fa.name', code: 'claim-word' }] },
    });
    expect(problem.fields).toEqual([{ locale: 'fa', field: 'name', kind: 'claim-word' }]);
  });

  it('maps a blocked term of validation.failed per field', () => {
    const problem = proposalProblemOf({
      status: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'texts.en-AU.shortDescription', code: 'blocked-term' }] },
    });
    expect(problem.form).toBe('validation-fields');
    expect(problem.fields[0]).toEqual({
      locale: 'en-AU',
      field: 'shortDescription',
      kind: 'blocked-term',
    });
  });

  it('maps shelf failures', () => {
    expect(shelfProblemOf({ status: 409, code: 'conflict.stale' })).toBe('stale');
    expect(shelfProblemOf({ status: 404, code: 'seller-category.not-found' })).toBe(
      'shelf-not-found',
    );
    expect(shelfProblemOf({ status: 0, code: 'network' })).toBe('unreachable');
  });
});
