/**
 * Jest configuration for the resmon renderer.
 *
 * The three specs under src/__tests__/ were written against
 * @testing-library/react + jest but had no runner, so they had never executed.
 * Jest rather than Vitest specifically because the specs already call
 * `jest.fn()` and friends; they run unchanged.
 */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    // Webpack resolves these through css-loader / asset modules; Jest needs a stub.
    '\\.(css|less|scss)$': '<rootDir>/src/__mocks__/styleMock.js',
    '\\.(png|jpe?g|gif|svg|webp)$': '<rootDir>/src/__mocks__/fileMock.js',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testTimeout: 15000,
};
