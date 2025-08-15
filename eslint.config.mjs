import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'

const TARGET_FILES = [
  'src/**/*.{js,mjs,cjs,ts,tsx}',
  'chrome-extension/**/*.{js,mjs,cjs,ts,tsx}'
]

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['**/node_modules/**']
  },
  {
    files: TARGET_FILES,
    rules: {
      'no-shadow': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description' }
      ],
      // note you must disable the base rule
      // as it can report incorrect errors
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn', // or "error"
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  },
  { files: TARGET_FILES, languageOptions: { globals: globals.browser } },
  { ...pluginJs.configs.recommended, files: TARGET_FILES },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: TARGET_FILES
  }))
]
