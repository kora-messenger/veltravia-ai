import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-run helper scripts (fixture generators, QA) use Node globals.
    files: ['scripts/**/*.{mjs,js,cjs}'],
    languageOptions: {
      globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
