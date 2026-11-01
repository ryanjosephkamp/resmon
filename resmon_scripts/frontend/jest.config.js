/**
 * Jest configuration: Atlas's own tests, in the `__tests__` folders beside its
 * code, and `tests/`, which holds the tests of the Electron main process, the
 * e2e harness's helpers, and the scripts that generate Atlas's code.
 */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/atlas/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)', '<rootDir>/tests/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    // Vite resolves these as assets; Jest needs a stub.
    '\\.(css|less|scss)$': '<rootDir>/tests/mocks/styleMock.js',
    '\\.(png|jpe?g|gif|svg|webp)$': '<rootDir>/tests/mocks/fileMock.js',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testTimeout: 15000,
};
