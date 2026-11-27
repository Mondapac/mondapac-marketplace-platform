import { CapabilityRegistry } from '../../../platform/ai/capability-registry';
import { EvaluationSuiteRegistry } from '../../../platform/ai/evaluations/evaluation-suite';
import type { ModelRequest, ModelTurn } from '../../../platform/ai/model-provider';
import { WRITER_EVALUATION_SET } from '../domain/description-writer/evaluation-set';
import { WRITER_MAX_OUTPUT_TOKENS } from '../domain/description-writer/writer-prompt';
import { CATALOG_AI_CAPABILITIES } from './ai-capabilities';
import { CATALOG_AI_EVALUATION_SUITES } from './ai-evaluation-suites';

const turnOf = (text: string, stop: ModelTurn['stop'] = 'end'): ModelTurn => ({
  blocks: [{ type: 'text', text }],
  stop,
  usage: { inputTokens: 10, outputTokens: 10 },
});

// catalog's evaluation suites (AI Gateway G4c) against a fake provider: the set's drafts as the
// answers, graded with the writer's own guard. Certification-claim leakage must be 0.
describe('catalog AI evaluation suites (G4c)', () => {
  it('register against catalog capabilities without tools, and seal', () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register('catalog', CATALOG_AI_CAPABILITIES);
    capabilities.seal();
    const suites = new EvaluationSuiteRegistry(capabilities);
    suites.register('catalog', CATALOG_AI_EVALUATION_SUITES);
    expect(() => suites.seal()).not.toThrow();
    expect(suites.ids()).toHaveLength(2);
  });

  describe.each(CATALOG_AI_EVALUATION_SUITES.map((suite) => [suite.capability, suite] as const))(
    '%s',
    (_capability, suite) => {
      it('sends only the synthetic case data, with no tools, every case', () => {
        expect(suite.sampleIds()).toEqual(WRITER_EVALUATION_SET.map((item) => item.id));
        for (const item of WRITER_EVALUATION_SET) {
          const request = suite.request(item.id)!;
          expect(request.tools).toEqual([]);
          expect(request.maxOutputTokens).toBe(WRITER_MAX_OUTPUT_TOKENS);
          expect(JSON.stringify(request)).toContain(item.input.title);
          expect(suite.label(item.id)).toContain(item.input.title);
        }
        expect(suite.request('nothing')).toBeNull();
        expect(suite.label('nothing')).toBeNull();
      });

      it.each(WRITER_EVALUATION_SET.map((item) => [item.id, item] as const))(
        'grades the draft of case %s as passed: nothing of mustNotShow reaches the field',
        (id, item) => {
          const grade = suite.grade(id, turnOf(item.draft));
          expect(grade).toEqual({ passed: true, checks: [] });
          const shown = (suite.display(id, turnOf(item.draft)) ?? '').toLowerCase();
          for (const banned of item.mustNotShow) expect(shown).not.toContain(banned.toLowerCase());
        },
      );

      it('fails an answer that drops every fact, ends early or stops at the cap', () => {
        const id = WRITER_EVALUATION_SET[0]!.id;
        expect(suite.grade(id, turnOf('Nice.')).checks).toContain('missing-fact');
        expect(suite.grade(id, turnOf('')).checks).toContain('empty');
        expect(suite.grade(id, turnOf('Tilda rice', 'max-tokens'))).toEqual({
          passed: false,
          checks: ['too-long'],
        });
        expect(suite.grade(id, { ...turnOf('x'), stop: 'tool-use' })).toEqual({
          passed: false,
          checks: ['incomplete'],
        });
        expect(suite.grade('nothing', turnOf('x')).passed).toBe(false);
      });

      it('shows plain text only: a tag or a link in the answer is not rendered (R9)', () => {
        const id = WRITER_EVALUATION_SET[0]!.id;
        const shown =
          suite.display(
            id,
            turnOf(
              '<script>alert(1)</script> Tilda basmati, aged 2 years. <a href="https://x.example">Buy</a>',
            ),
          ) ?? '';
        expect(shown).not.toMatch(/<script|<a\s|href=/i);
        expect(suite.display(id, turnOf(''))).toBeNull();
      });

      // G6c: the writer's own check of a real answer in a shadow sample, against the request sent.
      it('checks a shadow answer as the model would use it', () => {
        const id = WRITER_EVALUATION_SET[0]!.id;
        const request = suite.request(id)!;
        const shadow = (sent: ModelRequest, turn: ModelTurn) => suite.shadow!(sent, turn);
        expect(shadow(request, turnOf(WRITER_EVALUATION_SET[0]!.draft))).toBe('valid');
        // The guard takes a certification claim out: guard-rejected, even with other text kept.
        expect(shadow(request, turnOf('It is kosher. It is a long grain rice.'))).toBe(
          'guard-rejected',
        );
        // Nothing usable: no text alone, cut at the cap, or nothing left after the guard.
        expect(shadow(request, { ...turnOf('x'), stop: 'tool-use' })).toBe('invalid');
        expect(shadow(request, turnOf('Rice', 'max-tokens'))).toBe('invalid');
        expect(shadow(request, turnOf('It is healthy.'))).toBe('invalid');
        expect(shadow(request, turnOf(''))).toBe('invalid');
        // A number the request does not hold is a fact the model added: left out.
        expect(shadow(request, turnOf('It cooks in 987654 minutes.'))).toBe('invalid');
      });
    },
  );
});
