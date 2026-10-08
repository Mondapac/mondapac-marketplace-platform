/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper: {
    '^@mondapac/shared-kernel$': '<rootDir>/../../packages/shared-kernel/src/index.ts',
    // Fakes and builders (platform-foundations 8.1). Both entries map to the kernel's sources,
    // so tests load one copy of the kernel, as the built API loads one copy of its dist/.
    '^@mondapac/shared-kernel/testing$': '<rootDir>/../../packages/shared-kernel/src/testing.ts',
    // The actor and call-context constructors (identity slice 1c): platform entry adapters only.
    '^@mondapac/shared-kernel/contexts$': '<rootDir>/../../packages/shared-kernel/src/contexts.ts',
    // The authenticated-actor constructor (identity slice 2): identity's Authenticator only.
    '^@mondapac/shared-kernel/authenticated-actor$':
      '<rootDir>/../../packages/shared-kernel/src/authenticated-actor.ts',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
};
