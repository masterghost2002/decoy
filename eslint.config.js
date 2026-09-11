/**
 * One flat config for three quite different kinds of code, which is why it is
 * layered rather than flat in spirit:
 *
 *   - `packages/core`   pure TypeScript, no DOM and no chrome.*
 *   - `apps/extension`  TypeScript and React, plus node scripts
 *   - `playground`      plain browser JavaScript, served as-is with no build
 *
 * Type-aware rules are on, because the ones that matter here -- floating
 * promises, unnecessary conditionals on a value that cannot be null -- are
 * exactly the ones that need types to see. Formatting rules are off: Prettier
 * owns that, and a linter arguing with a formatter wastes everyone's time.
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/extension/public/**',
      'pnpm-lock.yaml',
    ],
  },

  /* ---------------------------------------------------------------------- */
  /* TypeScript                                                             */
  /* ---------------------------------------------------------------------- */
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // An unused argument is often documentation -- `(event, index)` says the
      // second one exists. Leading underscore is the opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `void promise` is used deliberately and often here to say "fire and
      // forget, on purpose".
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  /* -- React lives only in the UI and the panel -- */
  {
    files: ['apps/extension/src/ui/**/*.tsx', 'apps/extension/src/panel/**/*.tsx'],
    extends: [reactHooks.configs['recommended-latest']],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  /*
   * The primitives in `components/ui` follow the shadcn convention of exporting
   * a component and its variants from one file. Fast refresh gives that up; the
   * alternative is a second file per primitive, which is a worse trade.
   */
  {
    files: ['apps/extension/src/ui/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },

  /* -- Node scripts: no DOM, and a CLI that exits is not a smell -- */
  {
    files: ['apps/extension/scripts/**/*.mjs', '*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  /* ---------------------------------------------------------------------- */
  /* The playground: browser JavaScript with no build step                  */
  /* ---------------------------------------------------------------------- */
  {
    files: ['playground/**/*.js', 'playground/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  /* Tests may assert on things a rule would otherwise object to. */
  {
    files: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  prettier,
);
