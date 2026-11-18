import { IDENTITY_FACADE } from '../src/modules/identity/contracts';
import { createTestApp } from './support/test-app';

// The facade is built by a factory whose `inject` list is positional: a repeated or missing
// entry shifts every later use case into the wrong slot, which no type check catches (the
// `inject` array is untyped). Each slot must hold the use case its name says. A failure here
// means the wiring in identity.module.ts is wrong: fix the inject list, never this test.

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

it('gives every slot of the identity facade the use case it names', async () => {
  const { app } = await createTestApp();
  try {
    const facade = app.get<object>(IDENTITY_FACADE);
    const useCases = (facade as { useCases: Record<string, object> }).useCases;
    const slots = Object.entries(useCases);
    expect(slots.length).toBeGreaterThan(0);
    const wrong = slots
      .filter(([slot, useCase]) => useCase.constructor.name !== pascal(slot))
      .map(([slot, useCase]) => `${slot} holds ${useCase.constructor.name}`);
    expect(wrong).toEqual([]);
  } finally {
    await app.close();
  }
});
