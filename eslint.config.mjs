import pluginJs from '@eslint/js'
import perfectionist from 'eslint-plugin-perfectionist'
import globals from 'globals'

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['build/**'] },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, Bun: false },
    },
  },
  pluginJs.configs.recommended,
  perfectionist.configs['recommended-natural'],
]
