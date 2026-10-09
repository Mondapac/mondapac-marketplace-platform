import { onboardingStepsOf, sellerStatusOf, type StatusInput } from './seller-status';

// What the seller sees (sellers design 3.3; ux 3.3) and the steps card of S1 (ID 8.5; slice 5b):
// pure rules over the access state `identity` reports and the facts of the file. Nothing here
// names a Market; the Market-specific facts arrive as inputs.

const base: StatusInput = {
  access: 'pending',
  hasApprovedRevision: false,
  hasPendingOnboardingRevision: false,
  missing: [],
  outsideServiceArea: false,
  registerNegative: false,
};

describe('sellerStatusOf (design 3.3)', () => {
  it.each([
    ['details-incomplete', { missing: ['phone'] }],
    ['ready-to-submit', {}],
    ['outside-service-area', { outsideServiceArea: true }],
    ['outside-service-area', { outsideServiceArea: true, missing: ['slug'] }],
    ['awaiting-review', { hasPendingOnboardingRevision: true }],
    ['awaiting-review', { hasPendingOnboardingRevision: true, missing: ['slug'] }],
    ['changes-needed', { access: 'rejected' }],
    ['outside-service-area', { access: 'rejected', outsideServiceArea: true }],
    ['awaiting-review', { access: 'rejected', hasPendingOnboardingRevision: true }],
    ['approved', { access: 'approved', hasApprovedRevision: true }],
    ['file-check-needed', { access: 'approved' }],
    ['suspended', { access: 'suspended', hasApprovedRevision: true }],
    ['suspended', { access: 'suspended' }],
  ] as const)('is %s for %j', (code, patch) => {
    expect(sellerStatusOf({ ...base, ...(patch as Partial<StatusInput>) })).toBe(code);
  });

  it('does not let a definite register negative change the status (the step carries it)', () => {
    expect(sellerStatusOf({ ...base, registerNegative: true })).toBe('ready-to-submit');
  });
});

describe('onboardingStepsOf (ID 8.5; ux S1)', () => {
  const keys = (steps: ReturnType<typeof onboardingStepsOf>) =>
    steps.map((step) => [step.titleKey, step.state]);

  it('lists the five steps of sellers, owned by sellers', () => {
    const steps = onboardingStepsOf(base, 'ready-to-submit');

    expect(steps.map((step) => step.titleKey)).toEqual([
      'sellers.steps.business',
      'sellers.steps.address',
      'sellers.steps.number',
      'sellers.steps.slug',
      'sellers.steps.submit',
    ]);
    expect(new Set(steps.map((step) => step.owningModule))).toEqual(new Set(['sellers']));
  });

  it('shows a complete draft as four done steps and the submit step as the one action', () => {
    expect(keys(onboardingStepsOf(base, 'ready-to-submit'))).toEqual([
      ['sellers.steps.business', 'done'],
      ['sellers.steps.address', 'done'],
      ['sellers.steps.number', 'done'],
      ['sellers.steps.slug', 'done'],
      ['sellers.steps.submit', 'to-do'],
    ]);
  });

  it('counts the fields left of a step and holds the submit step back', () => {
    const input = { ...base, missing: ['storeName', 'phone', 'address', 'timezone'] } as const;

    const steps = onboardingStepsOf(input, 'details-incomplete');

    expect(steps[0]).toMatchObject({ state: 'to-do', fieldsLeft: 2 });
    expect(steps[1]).toMatchObject({ state: 'to-do', fieldsLeft: 2 });
    expect(steps[2]).toMatchObject({ state: 'done', fieldsLeft: null });
    expect(steps[4]).toMatchObject({ state: 'waiting', fieldsLeft: null });
  });

  it('asks for attention on the address outside the area and holds the submit step', () => {
    const steps = onboardingStepsOf({ ...base, outsideServiceArea: true }, 'outside-service-area');

    expect(steps[1]!.state).toBe('needs-attention');
    expect(steps[4]!.state).toBe('waiting');
  });

  it('asks for attention on the number after a definite register negative, with no value', () => {
    const steps = onboardingStepsOf({ ...base, registerNegative: true }, 'ready-to-submit');

    expect(steps[2]).toMatchObject({ state: 'needs-attention' });
    expect(steps[4]!.state).toBe('waiting');
    expect(JSON.stringify(steps)).not.toMatch(/not-found|cancelled/);
  });

  it('marks the number step to-do when it is missing, whether or not the Market requires it', () => {
    const steps = onboardingStepsOf({ ...base, missing: ['identifier'] }, 'details-incomplete');

    expect(steps[2]).toMatchObject({ state: 'to-do', fieldsLeft: 1 });
  });

  it('shows every step done and the submit step done once a submission waits', () => {
    const steps = onboardingStepsOf(
      { ...base, hasPendingOnboardingRevision: true },
      'awaiting-review',
    );

    expect(steps.every((step) => step.state === 'done')).toBe(true);
  });

  it('holds the submit step back while the seller is suspended or not yet reviewable', () => {
    const steps = onboardingStepsOf({ ...base, access: 'suspended' }, 'suspended');

    expect(steps[4]!.state).toBe('waiting');
  });
});
