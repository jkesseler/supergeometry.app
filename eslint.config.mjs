import stylistic from '@stylistic/eslint-plugin';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const eslintConfig = [
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-expressions': 'warn'
    }
  },
  {
    plugins: {
      '@stylistic': stylistic,
      import: importX
    },
    settings: {
      // Without extensions and parsers, import/named silently skips .ts files.
      'import-x/extensions': ['.ts', '.js', '.mjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts'] },
      'import-x/resolver-next': [createNodeResolver({ extensions: ['.ts', '.js', '.mjs', '.json'] })]
    },
    rules: {
      '@stylistic/arrow-parens': ['error', 'as-needed', { requireForBlockBody: true }],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
      '@stylistic/comma-dangle': ['error', 'never'],
      '@stylistic/indent': ['error', 2],
      '@stylistic/jsx-curly-brace-presence': ['error', { props: 'never', children: 'never' }],
      '@stylistic/jsx-quotes': ['error', 'prefer-double'],
      '@stylistic/member-delimiter-style': 'error',
      '@stylistic/multiline-ternary': ['error', 'always-multiline'],
      '@stylistic/operator-linebreak': ['error', 'before'],
      '@stylistic/padding-line-between-statements': ['error', { blankLine: 'always', prev: '*', next: 'return' }],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/semi': ['error', 'always'],
      camelcase: ['error', { properties: 'never' }],
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'id-length': ['warn', { min: 2, exceptions: ['a', 'b', 't', 'q', 'e', 'i', 'j', '_', 'x', 'y', 'z'], properties: 'never' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'import/named': 'error',
      'import/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
        pathGroups: [
          { pattern: '@/**', group: 'internal' }
        ],
        'newlines-between': 'never'
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: false,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^(_|ignore)'
        }
      ]
    }
  },
  {
    ignores: ['dist/', '.wrangler/', 'shots/']
  }
];

export default eslintConfig;
