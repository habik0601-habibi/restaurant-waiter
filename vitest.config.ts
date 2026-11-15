import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

const env = loadEnv('test', process.cwd(), '')

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'db',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          env,
          testTimeout: 30000,
          hookTimeout: 60000,
          fileParallelism: false,
        },
      },
    ],
  },
})
