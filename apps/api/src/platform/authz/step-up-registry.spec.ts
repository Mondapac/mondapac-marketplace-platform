import { StepUpActionRegistry, StepUpRegistryError } from './step-up-registry';

const action = (key: string, defaultRequired = false, locked = false) => ({
  key,
  defaultRequired,
  locked,
});

describe('StepUpActionRegistry', () => {
  it('lists the registered actions sorted by key and answers one by key', () => {
    const registry = new StepUpActionRegistry();
    registry.register('pricing', [action('pricing.price.change')]);
    registry.register('catalog', [action('catalog.offer.delete')]);

    expect(registry.list().map((a) => a.key)).toEqual([
      'catalog.offer.delete',
      'pricing.price.change',
    ]);
    expect(registry.get('pricing.price.change')).toEqual(action('pricing.price.change'));
    expect(registry.get('pricing.nothing.here')).toBeUndefined();
  });

  it.each([
    ['a duplicate key', () => [action('pricing.price.change'), action('pricing.price.change')]],
    ['a key of another module', () => [action('catalog.offer.delete')]],
    ['a malformed key', () => [action('Pricing.Price')]],
    ['a key with one segment', () => [action('pricing')]],
    ['a locked action that is not required', () => [action('pricing.price.change', false, true)]],
  ])('refuses %s at boot', (_name, actions) => {
    const registry = new StepUpActionRegistry();
    expect(() => registry.register('pricing', actions())).toThrow(StepUpRegistryError);
  });

  it('refuses a malformed module name', () => {
    expect(() => new StepUpActionRegistry().register('Pricing', [])).toThrow(StepUpRegistryError);
  });

  it('hands out frozen declarations', () => {
    const registry = new StepUpActionRegistry();
    const declared = action('pricing.price.change');
    registry.register('pricing', [declared]);

    expect(Object.isFrozen(registry.get('pricing.price.change'))).toBe(true);
    expect(registry.get('pricing.price.change')).not.toBe(declared);
  });
});
