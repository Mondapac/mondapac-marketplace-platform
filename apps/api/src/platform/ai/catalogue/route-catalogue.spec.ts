import { testRoute } from '../../../../test/support/ai-routes';
import { EvaluationResults } from '../evaluations/evaluation-results';
import { EVALUATION_PASSES } from '../evaluations/results';
import { checkedInCatalogue } from '.';
import { priceOf, RouteCatalogue } from './route-catalogue';

describe('the AI route catalogue (ADR-0052 decision 2)', () => {
  it('loads the checked-in rows, each valid and listed once', () => {
    const rows = checkedInCatalogue().rows();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('records no verified route yet: every row waits for Hassan (verification log empty)', () => {
    // Recording a check is a reviewed change of its own: this test changes with it.
    expect(
      checkedInCatalogue()
        .rows()
        .filter((row) => row.dataTerms !== null),
    ).toEqual([]);
    expect(EVALUATION_PASSES).toEqual([]);
  });

  it('keeps the fallback route of a model in Sydney, after the provider route', () => {
    const routes = checkedInCatalogue().routesOf('claude-haiku-5-5');
    expect(routes.map((row) => [row.route, row.region])).toEqual([
      ['anthropic-api', null],
      ['bedrock-mantle', 'ap-southeast-2'],
    ]);
  });

  it('reads a model given as a family or as one of its exact ids', () => {
    const catalogue = checkedInCatalogue();
    expect(catalogue.familyOf('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(catalogue.familyOf('anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(catalogue.familyOf('claude-sonnet-5-5-preview')).toBeNull();
  });

  it('prices a row in pico US dollars per token', () => {
    expect(priceOf(testRoute('m', 'anthropic-api', { inputUsdPerMTok: 0.1 }))).toEqual({
      inputPicoUsd: 100_000,
      outputPicoUsd: 5_000_000,
    });
  });

  it.each([
    ['an id that is not route/model', { id: 'x' }],
    ['an invalid region', { region: 'Sydney' }],
    ['a zero price', { inputUsdPerMTok: 0 }],
    ['a retirement that is not a day', { retiresOn: 'soon' }],
    [
      'a check without a reviewer',
      {
        dataTerms: {
          noRetention: true,
          noTraining: true,
          checkedOn: '2026-11-25',
          reference: 'r',
          reviewer: ' ',
        },
      },
    ],
  ] as const)('refuses a row with %s', (_name, overrides) => {
    expect(() => new RouteCatalogue([testRoute('m', 'anthropic-api', overrides as never)])).toThrow(
      /AI route catalogue/,
    );
  });

  it('refuses a row listed twice', () => {
    expect(() => new RouteCatalogue([testRoute('m'), testRoute('m')])).toThrow(/listed twice/);
  });

  it('refuses an evaluation pass without its day or reference', () => {
    expect(
      () =>
        new EvaluationResults([
          {
            capability: 'a.b',
            provider: 'anthropic',
            family: 'm',
            promptVersion: 'p',
            passedOn: '2026-11-25',
            reference: '',
          },
        ]),
    ).toThrow(/needs a day and a reference/);
  });
});
