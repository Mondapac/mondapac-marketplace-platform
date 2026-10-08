import { ExtensionPointRegistry, ExtensionRegistryError } from './extension-point-registry';

interface Handler {
  readonly typeCode: string;
}
const isHandler = (value: unknown): value is Handler =>
  typeof value === 'object' && value !== null && typeof (value as Handler).typeCode === 'string';

const POINT = 'catalog.product-type';

function open(): ExtensionPointRegistry {
  const registry = new ExtensionPointRegistry();
  registry.declarePoint(POINT, 'catalog', isHandler);
  return registry;
}

describe('ExtensionPointRegistry', () => {
  it('registers implementations of the owning module and of a Vertical, and reads them once sealed', () => {
    const registry = open();
    const simple = { typeCode: 'simple' };
    const special = { typeCode: 'special' };
    registry.register(POINT, 'simple', simple, { module: 'catalog' });
    registry.register(POINT, 'special-type', special, { vertical: 'some-vertical' });
    registry.seal();

    expect(registry.get(POINT, 'simple')).toBe(simple);
    expect(registry.get(POINT, 'special-type')).toBe(special);
    expect(registry.get(POINT, 'missing')).toBeUndefined();
    expect(registry.codes(POINT)).toEqual(['simple', 'special-type']);
    expect(registry.registrantOf(POINT, 'special-type')).toEqual({ vertical: 'some-vertical' });
    expect(registry.registrantOf(POINT, 'simple')).toEqual({ module: 'catalog' });
  });

  it('freezes what it stores, so a registered handler cannot be swapped afterwards', () => {
    const registry = open();
    const handler = { typeCode: 'simple' };
    registry.register(POINT, 'simple', handler, { module: 'catalog' });
    registry.seal();

    expect(Object.isFrozen(registry.get(POINT, 'simple'))).toBe(true);
    expect(() => {
      'use strict';
      handler.typeCode = 'other';
    }).toThrow(TypeError);
  });

  it('is sealed by the bootstrap hook and then refuses every change', () => {
    const registry = open();
    registry.onApplicationBootstrap();

    expect(registry.sealed).toBe(true);
    expect(() => registry.declarePoint('catalog.other', 'catalog', isHandler)).toThrow(
      ExtensionRegistryError,
    );
    expect(() =>
      registry.register(POINT, 'simple', { typeCode: 'simple' }, { module: 'catalog' }),
    ).toThrow('sealed');
  });

  it('refuses a read before sealing', () => {
    const registry = open();
    expect(() => registry.get(POINT, 'simple')).toThrow('after it is sealed');
    expect(() => registry.codes(POINT)).toThrow('after it is sealed');
  });

  it('refuses a duplicate code and a duplicate point', () => {
    const registry = open();
    registry.register(POINT, 'simple', { typeCode: 'simple' }, { module: 'catalog' });
    expect(() =>
      registry.register(POINT, 'simple', { typeCode: 'simple' }, { module: 'catalog' }),
    ).toThrow('registered twice');
    expect(() => registry.declarePoint(POINT, 'catalog', isHandler)).toThrow('declared twice');
  });

  it.each(['', 'a', 'Simple', '1simple', 'has_underscore', 'x'.repeat(33), 'a b'])(
    'refuses the malformed code %j',
    (code) => {
      expect(() => open().register(POINT, code, { typeCode: 'x' }, { module: 'catalog' })).toThrow(
        'not a valid code',
      );
    },
  );

  it('accepts the shortest and the longest code', () => {
    const registry = open();
    registry.register(POINT, 'ab', { typeCode: 'x' }, { module: 'catalog' });
    registry.register(POINT, 'a'.repeat(32), { typeCode: 'x' }, { module: 'catalog' });
    expect(registry.sealed).toBe(false);
  });

  it('refuses a registrant that is neither the owner nor a Vertical folder', () => {
    const registry = open();
    for (const registrant of [
      { module: 'sellers' },
      { vertical: 'Not A Folder' },
      { vertical: '../escape' },
      {},
      null,
      'catalog',
    ]) {
      expect(() =>
        registry.register(POINT, 'simple', { typeCode: 'x' }, registrant as never),
      ).toThrow('neither');
    }
  });

  it('refuses an implementation that does not fit, and a point that is not declared', () => {
    const registry = open();
    expect(() => registry.register(POINT, 'simple', { nope: 1 }, { module: 'catalog' })).toThrow(
      'does not fit',
    );
    expect(() => registry.register('catalog.unknown', 'simple', {}, { module: 'catalog' })).toThrow(
      'not declared',
    );
  });

  it('refuses a point id that does not start with its owner or is malformed', () => {
    const registry = new ExtensionPointRegistry();
    expect(() => registry.declarePoint('sellers.thing', 'catalog', isHandler)).toThrow(
      'starts with its owner',
    );
    expect(() => registry.declarePoint('catalog', 'catalog', isHandler)).toThrow(
      ExtensionRegistryError,
    );
    expect(() => registry.declarePoint('catalog.Thing', 'catalog', isHandler)).toThrow(
      ExtensionRegistryError,
    );
  });
});
