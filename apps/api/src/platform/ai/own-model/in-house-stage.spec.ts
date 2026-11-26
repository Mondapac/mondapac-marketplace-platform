import {
  checkInHouseTask,
  IN_HOUSE_STAGES,
  SERVED_IN_HOUSE_STAGES,
  SHADOW_CUSTOMER_DATA_APPROVAL,
  type InHouseProblem,
  type InHouseTaskPage,
} from './in-house-stage';

// The Mondapac Intelligence tab's stage rules (AI Gateway G6b; docs/design/domain/platform-ai.md
// section 8, "Conditions" and "In-house route readiness"), apart from the router: what is served
// today, the owner's approval for shadow, a model for a live stage and the stage's own share.

const page = (overrides: Partial<InHouseTaskPage> = {}): InHouseTaskPage => ({
  stage: 'off',
  family: null,
  shadowPercent: 0,
  rolloutPercent: 0,
  ...overrides,
});
const usable = (): InHouseProblem | null => null;

describe('in-house stage checks (G6b)', () => {
  it('serves only off today, and has no owner approval for customer data in shadow', () => {
    // G6c adds shadow and G6d percent and default, each by PR with its routing.
    expect(SERVED_IN_HOUSE_STAGES).toEqual(['off']);
    expect(SHADOW_CUSTOMER_DATA_APPROVAL).toBeNull();
    expect(IN_HOUSE_STAGES).toEqual(['off', 'shadow', 'percent', 'default']);
  });

  it('takes off with or without a model, and never asks the route of a model while off', () => {
    const asked: string[] = [];
    const notEvaluated = (family: string): InHouseProblem => {
      asked.push(family);
      return 'not-evaluated';
    };
    expect(checkInHouseTask(page(), notEvaluated)).toEqual({
      stage: null,
      family: null,
      shadowPercent: null,
      rolloutPercent: null,
    });
    // A share may be prepared while off.
    expect(
      checkInHouseTask(page({ family: 'house-1', shadowPercent: 40 }), notEvaluated).family,
    ).toBeNull();
    expect(asked).toEqual(['house-1']);
  });

  it('refuses an unknown or external family even while off', () => {
    expect(checkInHouseTask(page({ family: 'x' }), () => 'unknown-model').family).toBe(
      'unknown-model',
    );
    expect(checkInHouseTask(page({ family: 'x' }), () => 'external-model').family).toBe(
      'external-model',
    );
  });

  it.each(['shadow', 'percent', 'default'] as const)(
    'refuses %s while the gateway does not serve it',
    (stage) => {
      const check = checkInHouseTask(
        page({ stage, family: 'house-1', shadowPercent: 5, rolloutPercent: 5 }),
        usable,
      );
      expect(check.stage).toBe('stage-not-served');
    },
  );

  it('reports the route problem of a live stage, a missing model and a zero share', () => {
    // A live stage reaches the route check whatever the served list says.
    expect(
      checkInHouseTask(page({ stage: 'default', family: 'house-1' }), () => 'retired').family,
    ).toBe('retired');
    expect(checkInHouseTask(page({ stage: 'percent' }), usable)).toMatchObject({
      family: null,
      rolloutPercent: 'no-share',
      shadowPercent: null,
    });
    expect(
      checkInHouseTask(page({ stage: 'shadow', family: 'house-1' }), usable).shadowPercent,
    ).toBe('no-share');
    // The other stage's share plays no part.
    expect(
      checkInHouseTask(page({ stage: 'default', family: 'house-1' }), usable).rolloutPercent,
    ).toBeNull();
  });
});
