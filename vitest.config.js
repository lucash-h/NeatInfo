import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, not Node, so HTMLRewriter, D1 and R2 behave the
// way they do in production rather than the way a mock would. The bindings
// come from wrangler.toml so there is one description of the environment.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // vitest-pool-workers 0.22 dropped the per-test `isolatedStorage`
      // rollback, so tests share one D1 file. `resetDb()` in test/helpers.js
      // is what makes each test independent -- call it in beforeEach.
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
