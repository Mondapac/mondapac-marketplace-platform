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
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
};
