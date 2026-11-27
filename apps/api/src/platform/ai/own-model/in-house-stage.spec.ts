import {
  checkInHouseTask as checkWith,
  IN_HOUSE_STAGES,
  SERVED_IN_HOUSE_STAGES,
  SHADOW_CUSTOMER_DATA_APPROVALS,
  inHouseStageInForce,
  rollbackLimitsInForce,
  shadowApprovedFor,
  type InHouseProblem,
  type InHouseTaskPage,
  type ShadowApprovals,
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
/** One capability of the task type, sending seller texts; no approval unless one is given. */
const checkInHouseTask = (
  marketId: string,
  taskPage: InHouseTaskPage,
  familyProblem: (family: string) => InHouseProblem | null,
  approvals: ShadowApprovals = {},
) => checkWith(marketId, taskPage, familyProblem, [['seller-text']], approvals);
const APPROVED: ShadowApprovals = {
  AU: { recordedIn: 'ADR-0052', approvedOn: '2026-11-27', categories: ['seller-text'] },
};

describe('in-house stage checks (G6b, G6c)', () => {
  it('serves every stage since G6d2, and has no owner approval for customer data in shadow', () => {
    // G6c serves shadow; G6d2 adds percent and default with their routing.
    expect(SERVED_IN_HOUSE_STAGES).toEqual(['off', 'shadow', 'percent', 'default']);
    expect(SHADOW_CUSTOMER_DATA_APPROVALS).toEqual({});
    expect(IN_HOUSE_STAGES).toEqual(['off', 'shadow', 'percent', 'default']);
  });

  it('takes off with or without a model, and never asks the route of a model while off', () => {
    const asked: string[] = [];
    const notEvaluated = (family: string): InHouseProblem => {
      asked.push(family);
      return 'not-evaluated';
    };
    expect(checkInHouseTask('AU', page(), notEvaluated)).toEqual({
      stage: null,
      family: null,
      shadowPercent: null,
      rolloutPercent: null,
    });
    // A share may be prepared while off.
    expect(
      checkInHouseTask('AU', page({ family: 'house-1', shadowPercent: 40 }), notEvaluated).family,
    ).toBeNull();
    expect(asked).toEqual(['house-1']);
  });

  it('refuses an unknown or external family even while off', () => {
    expect(checkInHouseTask('AU', page({ family: 'x' }), () => 'unknown-model').family).toBe(
      'unknown-model',
    );
    expect(checkInHouseTask('AU', page({ family: 'x' }), () => 'external-model').family).toBe(
      'external-model',
    );
  });

  it.each(['percent', 'default'] as const)(
    'takes %s with a usable model and its share, without an owner approval (G6d2)',
    (stage) => {
      const check = checkInHouseTask(
        'AU',
        page({ stage, family: 'house-1', shadowPercent: 0, rolloutPercent: 5 }),
        usable,
      );
      expect(check).toEqual({
        stage: null,
        family: null,
        shadowPercent: null,
        rolloutPercent: null,
      });
    },
  );

  it('reports the route problem of a live stage, a missing model and a zero share', () => {
    // A live stage reaches the route check whatever the served list says.
    expect(
      checkInHouseTask('AU', page({ stage: 'default', family: 'house-1' }), () => 'retired').family,
    ).toBe('retired');
    expect(checkInHouseTask('AU', page({ stage: 'percent' }), usable)).toMatchObject({
      family: null,
      rolloutPercent: 'no-share',
      shadowPercent: null,
    });
    expect(
      checkInHouseTask('AU', page({ stage: 'shadow', family: 'house-1' }), usable, APPROVED)
        .shadowPercent,
    ).toBe('no-share');
    // The other stage's share plays no part.
    expect(
      checkInHouseTask('AU', page({ stage: 'default', family: 'house-1' }), usable).rolloutPercent,
    ).toBeNull();
  });

  it('takes shadow only with the owner approval of every category of one capability (FE-280)', () => {
    const shadow = page({ stage: 'shadow', family: 'house-1', shadowPercent: 10 });
    expect(checkInHouseTask('AU', shadow, usable).stage).toBe('shadow-not-approved');
    expect(checkInHouseTask('ZZ', shadow, usable, APPROVED).stage).toBe('shadow-not-approved');
    expect(checkInHouseTask('AU', shadow, usable, APPROVED)).toEqual({
      stage: null,
      family: null,
      shadowPercent: null,
      rolloutPercent: null,
    });
    // A capability with a category the owner did not approve does not make the stage stand;
    // one fully approved capability of the task type does (the other is never sent to shadow).
    expect(
      checkWith('AU', shadow, usable, [['seller-text', 'certificate-file']], APPROVED).stage,
    ).toBe('shadow-not-approved');
    expect(
      checkWith('AU', shadow, usable, [['certificate-file'], ['seller-text']], APPROVED).stage,
    ).toBeNull();
    // No capability of the task type: nothing could be sent, so shadow is not approved.
    expect(checkWith('AU', shadow, usable, [], APPROVED).stage).toBe('shadow-not-approved');
    // A shadow stage still meets the route checks of its model.
    expect(checkInHouseTask('AU', shadow, () => 'not-evaluated', APPROVED).family).toBe(
      'not-evaluated',
    );
  });

  it('approves a capability for shadow only when every category it declares is approved', () => {
    expect(shadowApprovedFor('AU', ['seller-text'], APPROVED)).toBe(true);
    expect(shadowApprovedFor('AU', ['seller-text', 'customer-message'], APPROVED)).toBe(false);
    expect(shadowApprovedFor('AU', [], APPROVED)).toBe(false);
    expect(shadowApprovedFor('ZZ', ['seller-text'], APPROVED)).toBe(false);
    // A key of the object prototype is no approval.
    expect(shadowApprovedFor('constructor', ['seller-text'], APPROVED)).toBe(false);
    expect(shadowApprovedFor('AU', ['seller-text'])).toBe(false);
  });

  it('serves a stored shadow stage only with the approval, a model and a share', () => {
    const shadow = page({ stage: 'shadow', family: 'house-1', shadowPercent: 5 });
    expect(inHouseStageInForce('AU', shadow, APPROVED)).toBe('shadow');
    expect(inHouseStageInForce('AU', shadow)).toBe('off');
    expect(inHouseStageInForce('ZZ', shadow, APPROVED)).toBe('off');
    expect(inHouseStageInForce('AU', { ...shadow, family: null }, APPROVED)).toBe('off');
    expect(inHouseStageInForce('AU', { ...shadow, shadowPercent: 0 }, APPROVED)).toBe('off');
    expect(inHouseStageInForce('AU', { ...shadow, shadowPercent: 101 }, APPROVED)).toBe('off');
    expect(inHouseStageInForce('AU', { ...shadow, shadowPercent: Number.NaN }, APPROVED)).toBe(
      'off',
    );
  });

  it('serves a stored stage only as the rules allow it, else off (the read G6c and G6d use)', () => {
    // Shadow needs the Market's approval; the live stages are served as stored (G6d2).
    const full = { family: 'house-1', shadowPercent: 5, rolloutPercent: 5 };
    expect(inHouseStageInForce('AU', page({ stage: 'shadow', ...full }))).toBe('off');
    expect(inHouseStageInForce('AU', page({ stage: 'shadow', ...full }), APPROVED)).toBe('shadow');
    expect(inHouseStageInForce('AU', page({ stage: 'percent', ...full }))).toBe('percent');
    expect(inHouseStageInForce('AU', page({ stage: 'default', ...full }))).toBe('default');
    // A live stage without a model, or percent without its share or above 99 %, is off.
    expect(inHouseStageInForce('AU', page({ stage: 'default', ...full, family: null }))).toBe(
      'off',
    );
    expect(inHouseStageInForce('AU', page({ stage: 'percent', ...full, rolloutPercent: 0 }))).toBe(
      'off',
    );
    expect(
      inHouseStageInForce('AU', page({ stage: 'percent', ...full, rolloutPercent: 100 })),
    ).toBe('off');
    expect(inHouseStageInForce('AU', page({ family: 'house-1' }))).toBe('off');
  });

  it('clamps stored rollback limits into the server bounds, a broken value at the tightest', () => {
    expect(rollbackLimitsInForce({ errorsPermille: 500, guardPermille: 0, minSample: 1 })).toEqual({
      errorsPermille: 50,
      guardPermille: 1,
      minSample: 100,
    });
    expect(
      rollbackLimitsInForce({ errorsPermille: Number.NaN, guardPermille: 10, minSample: 99_999 }),
    ).toEqual({ errorsPermille: 1, guardPermille: 10, minSample: 10_000 });
  });
});
