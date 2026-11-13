import { draftText, guardDraft, MAX_DRAFT_CHARS, sentenceVerdict } from './draft-guard';
import { WRITER_EVALUATION_SET, WRITER_EVALUATION_VERSION } from './evaluation-set';
import { WRITER_PROMPT_VERSION, writerFacts } from './writer-prompt';
import { parseWriterRequest } from './writer-request';

function factsOf(input: (typeof WRITER_EVALUATION_SET)[number]['input']): string {
  const parsed = parseWriterRequest(input);
  if (!parsed.ok) throw new Error(`evaluation input does not parse: ${JSON.stringify(parsed.error)}`);
  return writerFacts(parsed.value);
}

describe('description writer evaluation set', () => {
  it('is bound to the prompt version', () => {
    expect(WRITER_EVALUATION_VERSION).toBe(WRITER_PROMPT_VERSION);
  });

  it.each(WRITER_EVALUATION_SET.map((c) => [c.id, c] as const))(
    '%s: nothing it must not show reaches the field, and the useful part stays',
    (_id, evaluationCase) => {
      const guarded = guardDraft(evaluationCase.draft, factsOf(evaluationCase.input));
      const text = draftText(guarded.sentences).toLowerCase();
      for (const banned of evaluationCase.mustNotShow) {
        expect(text).not.toContain(banned.toLowerCase());
      }
      for (const kept of evaluationCase.mustShow ?? []) {
        expect(text).toContain(kept.toLowerCase());
      }
    },
  );

  it('leaks no certification claim across the whole set (leakage = 0)', () => {
    const claim = /hala+l|kosher|certif|zabih|organic|حلال/iu;
    const leaks = WRITER_EVALUATION_SET.filter((c) =>
      claim.test(draftText(guardDraft(c.draft, factsOf(c.input)).sentences)),
    ).map((c) => c.id);
    expect(leaks).toEqual([]);
  });
});

describe('guardDraft', () => {
  const facts = 'Sella basmati rice. Cooks in 15 minutes.';

  it('counts left-out sentences by reason', () => {
    const guarded = guardDraft('It is kosher. It is healthy. It cooks in 15 minutes.', facts);
    expect(guarded.leftOut).toEqual({ certification: 1, other: 1 });
    expect(draftText(guarded.sentences)).toBe('It cooks in 15 minutes.');
  });

  it('keeps paragraphs, renumbered over dropped ones', () => {
    const guarded = guardDraft('Firm grains.\n\nIt is vegan.\n\nGood for pilaf.', facts);
    expect(draftText(guarded.sentences)).toBe('Firm grains.\n\nGood for pilaf.');
  });

  it('keeps a decimal number whole when it is given', () => {
    expect(sentenceVerdict('A 2.5 kg bag.', 'Pack 2.5 kg')).toBeNull();
    expect(sentenceVerdict('A 3 kg bag.', 'Pack 2.5 kg')).toBe('other');
  });

  it('removes invisible and bidi characters', () => {
    const text = draftText(guardDraft('Firm​ grains‮ for pilaf.', facts).sentences);
    expect(text).toBe('Firm grains for pilaf.');
  });

  it('cuts the kept text at a sentence once it reaches the bound', () => {
    const sentence = 'Firm long grains that stay apart in the pot. ';
    const guarded = guardDraft(sentence.repeat(100), facts);
    const text = draftText(guarded.sentences);
    expect(text.length).toBeLessThanOrEqual(MAX_DRAFT_CHARS);
    expect(text.endsWith('pot.')).toBe(true);
  });

  it('returns nothing for a draft of only refused sentences', () => {
    const guarded = guardDraft('Certified halal. Free delivery.', facts);
    expect(guarded.sentences).toEqual([]);
    expect(guarded.leftOut).toEqual({ certification: 1, other: 1 });
  });
});
