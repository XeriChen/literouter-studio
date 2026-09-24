import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TransformStream: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  structuredClone: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  matchMedia: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  HTMLElement: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  FileReader: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  visualViewport: 'readonly',
  confirm: 'readonly',
  alert: 'readonly',
  prompt: 'readonly',
  React: 'readonly',
};

export default [
  {
    // ESLint 不读 .gitignore（含各级嵌套 .gitignore），本地工具/会话状态目录必须显式忽略，
    // 否则 agent 工具产生的临时 .ts 文件会直接判错并让 pnpm check / 部署门禁失败。
    ignores: [
      'web/dist/**',
      'node_modules/**',
      'data/**',
      'temp/**',
      'test-results/**',
      'coverage/**',
      '.remember/**',
      '.pi/**',
      '.claude/**',
      '.agents/**',
      '.mimocode/**',
      '.opencode/**',
      '.codebuddy/**',
      '.zcode/**',
      '.trae/**',
      '.qoder/**',
      '.superpowers/**',
      'docs/superpowers/**',
      '.playwright-cli/**',
      '.playwright-mcp/**',
      'gui-test-screenshots/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: nodeGlobals,
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-undef': 'off',
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: browserGlobals,
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/no-unescaped-entities': 'off',
      // React Compiler 相关新规则先降为 warn，避免门禁被风格类问题卡死
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
    settings: {
      react: {
        version: '19.3',
      },
    },
  },
  {
    files: ['test/**/*.{ts,tsx,js,mjs}', 'scripts/**/*.{js,mjs}', 'eslint.config.js', 'vite.config.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        ...browserGlobals,
      },
    },
    rules: {
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  prettier,
];
