import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environmentMatchGlobs: [
      ['**/*.test.jsx', 'jsdom'],
      ['**/*.test.js', 'node']
    ]
  }
})
