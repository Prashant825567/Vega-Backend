module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // The tests are type-checked as they run: ts-jest's default tsconfig is the
  // build one, which knows nothing about `describe`/`it`, so the test config
  // carries the jest types instead.
  transform: {
    '^.+\\.ts$': ['ts-jest', {tsconfig: 'tsconfig.test.json'}],
  },
  // Runs before any test module is imported: the key/value store reads its file
  // at import time, so the location has to be decided before that happens.
  setupFiles: ['<rootDir>/tests/setup.ts'],
  clearMocks: true,
  testTimeout: 20000,
};
