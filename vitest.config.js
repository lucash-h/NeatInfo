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
      // wrangler.test.toml, not wrangler.toml: identical except that the
      // Workers AI binding is removed. AI has no local mode, so declaring it
      // makes this pool open a remote proxy session requiring
      // CLOUDFLARE_API_TOKEN -- which would make `npm test` depend on
      // Cloudflare credentials, including in CI, where the test gate runs
      // *before* the step that has them. Speech tests stub env.AI themselves.
      wrangler: { configPath: './wrangler.test.toml' },
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
