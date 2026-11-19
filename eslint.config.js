import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['work/', 'dist/', 'coverage/', 'test/upstream/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['**/*.js', '**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  {
    // The browser tests' page, server and Safari scripts, and the examples (not type-checked).
    files: ['test/browser/**/*.{js,mjs}', 'examples/**/*.{js,mjs}'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'AbortController',
          'AbortSignal',
          'Blob',
          'clearTimeout',
          'console',
          'document',
          'fetch',
          'File',
          'location',
          'navigator',
          'performance',
          'ReadableStream',
          'Response',
          'self',
          'setTimeout',
          'TextDecoder',
          'TextDecoderStream',
          'TextEncoder',
          'URL',
          'URLSearchParams',
          'Worker',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
);
