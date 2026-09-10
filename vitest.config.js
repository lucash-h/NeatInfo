import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, not Node, so HTMLRewriter, D1 and R2 behave the
// way they do in production rather than the way a mock would. The bindings
// come from wrangler.toml so there is one description of the environment.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Each test file gets its own storage, and every test's writes are
      // rolled back after it -- schema goes in beforeAll, fixtures per test.
      isolatedStorage: true,
      singleWorker: true,
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Never the real values; the passphrase and signing key are secrets
        // in production (`wrangler secret put`).
        bindings: {
          PASSPHRASE: 'test-passphrase',
          SESSION_SECRET: 'test-session-secret'
        }
      }
    })
  ],
  test: {
    include: ['test/**/*.test.js']
  }
});
