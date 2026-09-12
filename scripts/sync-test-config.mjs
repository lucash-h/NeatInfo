// Regenerates wrangler.test.toml from wrangler.toml with the [ai] binding
// removed, and can check that it is up to date.
//
//   node scripts/sync-test-config.mjs           # check only, exit 1 if stale
//   node scripts/sync-test-config.mjs --write   # regenerate
//
// Why a second config exists at all: Workers AI has no local mode. Declaring
// the binding makes vitest-pool-workers open a remote proxy session, which
// requires CLOUDFLARE_API_TOKEN. That would make `npm test` depend on
// Cloudflare credentials and connectivity -- including in CI, where the test
// gate deliberately runs *before* the steps that hold those credentials. Every
// speech test stubs env.AI itself, so in tests the binding was pure overhead.
//
// Two files describing one environment is exactly the drift this project keeps
// meeting (worker/url.js and discover/url.js carry a "keep in sync" comment
// for the same reason). So this one is generated, never hand-edited, and a
// test asserts it matches.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const HEADER = `# Generated from wrangler.toml with the [ai] binding removed. Do not edit.
#
# Workers AI has no local mode: declaring the binding makes vitest open a
# remote proxy session, which needs CLOUDFLARE_API_TOKEN. That would make the
# whole test suite depend on Cloudflare credentials and connectivity -- and it
# would break the CI test gate, which runs before the deploy step that has the
# credentials. Every speech test stubs env.AI anyway, so the binding was pure
# overhead in tests.
#
# Regenerate with: node scripts/sync-test-config.mjs --write
`;

// Drops a named top-level table and the blank line that follows it.
export function stripBlock(toml, table) {
  const out = [];
  let skipping = false;
  for (const line of toml.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === table) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // The block ends at the next table header, or at a blank line that is
      // already preceded by a blank one.
      if (line.startsWith('[')) skipping = false;
      else if (line.trim() === '' && out.length && out[out.length - 1].trim() === '') skipping = false;
      else continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function buildTestConfig(source) {
  return HEADER + stripBlock(source, '[ai]');
}

async function main() {
  const write = globalThis.process.argv.includes('--write');
  const source = await readFile(join(appDir, 'wrangler.toml'), 'utf8');
  const expected = buildTestConfig(source);

  if (write) {
    await writeFile(join(appDir, 'wrangler.test.toml'), expected, 'utf8');
    console.log('wrangler.test.toml regenerated.');
    return;
  }

  const actual = await readFile(join(appDir, 'wrangler.test.toml'), 'utf8').catch(() => null);
  if (actual?.replace(/\r\n/g, '\n') === expected) {
    console.log('wrangler.test.toml is up to date.');
    return;
  }
  console.error('wrangler.test.toml is stale. Run: node scripts/sync-test-config.mjs --write');
  globalThis.process.exitCode = 1;
}

const argv = globalThis.process?.argv;
if (argv && typeof argv[1] === 'string' && argv[1].replace(/\\/g, '/').endsWith('scripts/sync-test-config.mjs')) {
  await main().catch((err) => {
    console.error(String(err.message || err));
    globalThis.process.exitCode = 1;
  });
}
