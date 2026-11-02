import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // The generated Android project: Gradle build output plus the minified web
      // bundle Capacitor copies into the APK. Neither is hand-written source, and
      // linting a minified bundle produces a thousand meaningless findings.
      'apps/mobile/android/**',
    ],
  },
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
