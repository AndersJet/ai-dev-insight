import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'trae-plugin/host-capability-probe/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  { files: ['**/*.vue'], languageOptions: { parser: vueParser, parserOptions: { parser: ts.parser, extraFileExtensions: ['.vue'] }, globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', File: 'readonly', Blob: 'readonly', URL: 'readonly', Event: 'readonly', HTMLInputElement: 'readonly', HTMLElement: 'readonly', crypto: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } }, rules: { 'vue/multi-word-component-names': 'off' } },
  { files: ['scripts/*.mjs', '**/*.cjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } } },
  { files: ['apps/web/src/**/*.{ts,vue}', 'packages/contracts/src/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['@adi/api', '@adi/collector', '@adi/hook-client', '@adi/storage', '@adi/domain', '**/apps/api/**', '**/apps/collector/**', '**/apps/hook-client/**', '**/server/**'], message: 'Browser contracts must not import server or local-client runtime implementations.' }] }] } },
);
