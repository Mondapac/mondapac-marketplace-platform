import { testInHouseRoute, testRoute } from '../../../../test/support/ai-routes';
import { EvaluationResults } from '../evaluations/evaluation-results';
import { EVALUATION_PASSES } from '../evaluations/results';
import { checkedInCatalogue } from '.';
import { inHouseCallUrl, inHouseEndpointProblem, priceOf, RouteCatalogue } from './route-catalogue';

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
      'a cross-region Bedrock profile',
      { id: 'bedrock-mantle/apac.anthropic.m', route: 'bedrock-mantle', model: 'apac.anthropic.m' },
    ],
    [
      'a global Bedrock profile',
      {
        id: 'bedrock-mantle/global.anthropic.m',
        route: 'bedrock-mantle',
        model: 'global.anthropic.m',
      },
    ],
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

  it('takes the Australian Bedrock profile', () => {
    expect(
      () =>
        new RouteCatalogue([
          testRoute('m', 'bedrock-mantle', {
            id: 'bedrock-mantle/au.anthropic.m',
            model: 'au.anthropic.m',
          }),
        ]),
    ).not.toThrow();
  });

  it('refuses a checked-in anthropic-api row with a region (no region control on that route yet)', () => {
    expect(() => checkedInCatalogue([testRoute('m', 'anthropic-api')])).toThrow(
      /records no region until the adapter pins one/,
    );
    expect(() =>
      checkedInCatalogue([testRoute('m', 'anthropic-api', { region: null })]),
    ).not.toThrow();
  });

  it('takes a family of at most 20 characters, so 3 fit one settings list (G4b)', () => {
    expect(() => new RouteCatalogue([testRoute('a'.repeat(20))])).not.toThrow();
    expect(() => new RouteCatalogue([testRoute('a'.repeat(21))])).toThrow(/family/);
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

  describe('the in-house model rows (ADR-0052 decision 6, G6a)', () => {
    it('checks in no in-house row yet: the partner endpoint is added by PR', () => {
      expect(
        checkedInCatalogue()
          .rows()
          .filter((row) => row.provider === 'mondapac' || row.route === 'in-house-http'),
      ).toEqual([]);
    });

    it('refuses a checked-in in-house row until the connect-time address check is built', () => {
      expect(() => checkedInCatalogue([testInHouseRoute('mi')])).toThrow(
        /no in-house row before the connect-time address check/,
      );
    });

    it('takes an in-house row with its endpoint and keeps it out of the external families', () => {
      const catalogue = new RouteCatalogue([testRoute('m'), testInHouseRoute('mi')]);
      expect(catalogue.families()).toEqual(['m', 'mi']);
      expect(catalogue.externalFamilies()).toEqual(['m']);
      expect(catalogue.isInHouse('mi')).toBe(true);
      expect(catalogue.isInHouse('m')).toBe(false);
      expect(catalogue.routesOf('mi')[0]!.endpoint).toBe('https://intelligence.example.com/model');
    });

    it.each([
      ['no endpoint', { endpoint: undefined }],
      ['an external provider', { provider: 'anthropic' }],
      ['an http endpoint', { endpoint: 'http://intelligence.example.com' }],
    ] as const)('refuses an in-house row with %s', (_name, overrides) => {
      expect(() => new RouteCatalogue([testInHouseRoute('mi', overrides as never)])).toThrow(
        /AI route catalogue/,
      );
    });

    it('refuses the mondapac provider or an endpoint on an external route', () => {
      expect(
        () => new RouteCatalogue([testRoute('m', 'anthropic-api', { provider: 'mondapac' })]),
      ).toThrow(/in-house route serves the mondapac provider only/);
      expect(
        () =>
          new RouteCatalogue([
            testRoute('m', 'anthropic-api', { endpoint: 'https://intelligence.example.com' }),
          ]),
      ).toThrow(/only an in-house row names an endpoint/);
    });

    it('refuses in-house rows on two origins, so the Market key reaches one host only', () => {
      expect(
        () =>
          new RouteCatalogue([
            testInHouseRoute('mi'),
            testInHouseRoute('mj', { endpoint: 'https://staging.intelligence.example.com/model' }),
          ]),
      ).toThrow(/another in-house origin/);
      expect(
        () =>
          new RouteCatalogue([
            testInHouseRoute('mi'),
            testInHouseRoute('mj', { endpoint: 'https://intelligence.example.com/model-2' }),
          ]),
      ).not.toThrow();
    });

    it('builds the call address from the parsed endpoint', () => {
      expect(inHouseCallUrl('https://intelligence.example.com/model/')).toBe(
        'https://intelligence.example.com/model/v1/messages',
      );
      expect(inHouseCallUrl('https://intelligence.example.com')).toBe(
        'https://intelligence.example.com/v1/messages',
      );
    });

    it('refuses a family served by two providers', () => {
      expect(() => new RouteCatalogue([testRoute('m'), testInHouseRoute('m')])).toThrow(
        /has two providers/,
      );
    });

    it.each([
      ['https://intelligence.example.com', null],
      ['https://intelligence.example.com/', null],
      ['https://ap-southeast-2.intelligence.example.com.au/model/v-a_1', null],
      ['not a url', 'has other than printable ASCII'],
      ['intelligence.example.com', 'not a URL'],
      ['https:intelligence.example.com', 'is not written in its canonical form'],
      ['https://Intelligence.example.com', 'is not written in its canonical form'],
      ['https://intelligence.example.com:443', 'carries a port'],
      ['https://intelligence.example.com /model', 'has other than printable ASCII'],
      ['https://intelligence.example.com\t', 'has other than printable ASCII'],
      ['https://\u043f\u0440\u0438\u043c\u0435\u0440.com', 'has other than printable ASCII'],
      ['https://\uff41\uff49.example.com', 'has other than printable ASCII'],
      ['https://exa\u00admple.com', 'has other than printable ASCII'],
      ['https://xn--e1afmkfd.com', 'the host has an IDN label'],
      ['https://a/%2e%2e/b', 'the host is not a DNS name'],
      ['https://intelligence.example.com/a/%2e%2e/b', 'the path has other than plain segments'],
      ['https://intelligence.example.com/a/../b', 'is not written in its canonical form'],
      ['https://intelligence.example.com/.hidden', 'the path has other than plain segments'],
      ['https://model.localhost', 'the host is a special-use name'],
      ['https://model.internal', 'the host is a special-use name'],
      ['https://model.local', 'the host is a special-use name'],
      ['https://127.0.0.1.nip.io', 'the host is a wildcard-IP name'],
      ['https://1.2.3.4.sslip.io', 'the host is a wildcard-IP name'],
      ['http://intelligence.example.com', 'not https'],
      ['https://user@intelligence.example.com', 'carries a user'],
      ['https://intelligence.example.com:8443', 'carries a port'],
      ['https://intelligence.example.com/?a=1', 'carries a query or fragment'],
      ['https://intelligence.example.com/#x', 'carries a query or fragment'],
      ['https://10.0.0.5', 'the host is not a DNS name'],
      ['https://[::1]', 'the host is not a DNS name'],
      ['https://localhost', 'the host is not a DNS name'],
      ['https://intelligence.example.com/a%2f..', 'the path has other than plain segments'],
      [`https://intelligence.example.com/${'a'.repeat(200)}`, 'longer than 200 characters'],
    ])('checks the endpoint %s', (endpoint, problem) => {
      expect(inHouseEndpointProblem(endpoint)).toBe(problem);
    });
  });
});
