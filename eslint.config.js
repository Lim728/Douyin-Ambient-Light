import js from '@eslint/js';
import globals from 'globals';

/** Shared rule set for every JavaScript file in the repository. */
const base = {
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    globals: {
      ...globals.browser,
      chrome: 'readonly',
      browser: 'readonly',
    },
  },
  rules: {
    ...js.configs.recommended.rules,
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    eqeqeq: ['error', 'smart'],
    'prefer-const': 'error',
    'no-var': 'error',
    'object-shorthand': ['error', 'properties'],
    'no-console': ['warn', { allow: ['warn', 'error', 'info', 'debug'] }],
  },
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  base,
  {
    files: ['src/main-world/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['scripts/**/*.mjs', 'tools/**/*.mjs', 'tests/**/*.js', 'tests/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-console': 'off' },
  },
];
