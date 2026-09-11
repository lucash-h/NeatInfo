// Restore half of V1-24. GET /api/export produces a JSON payload; this turns
// it into a .sql file that `wrangler d1 execute neatinfo --file=` can replay
// against a freshly-schema'd, empty database. The statement building itself
// lives in worker/importer.js so the same logic is exercised by the test
// suite (in workerd, against a real D1) rather than only by this script.
//
// Usage (nothing to install; Node 18+):
//
//   node scripts/import.mjs --file neatinfo-2026-09-10.json --out restore.sql
//   node scripts/import.mjs --file neatinfo-2026-09-10.json --out restore.sql --force
//     (--force overwrites an existing --out file; without it the script
//     refuses, because this is a restore tool and a silent overwrite of a
//     hand-checked .sql file is exactly the kind of mistake worth blocking.)
//
//   wrangler d1 execute neatinfo --remote --file=restore.sql
//
// D1's schema must already be applied (schema.sql) and the tables empty --
// this script does not truncate anything itself.

import { buildImportStatements, renderStatement } from '../worker/importer.js';

function tableOf(sql) {
  const m = sql.match(/INTO\s+(\w+)/i);
  return m ? m[1] : 'other';
}

function usage() {
  console.log(`Usage: node scripts/import.mjs --file <export.json> --out <restore.sql> [--force]

Turns a NeatInfo export (GET /api/export) into a .sql file for
  wrangler d1 execute neatinfo --file=<restore.sql>

Options:
  --file <path>   export JSON to read (required)
  --out <path>    .sql file to write (required)
  --force         overwrite --out if it already exists
  --help          show this message`);
}

async function main() {
  const { readFile, writeFile, access } = await import('node:fs/promises');
  const args = globalThis.process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  const file = arg('--file');
  const out = arg('--out');
  const force = args.includes('--force');

  if (!file || !out) {
    usage();
    globalThis.process.exitCode = 1;
    return;
  }

  if (!force) {
    const exists = await access(out).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(`${out} already exists. Pass --force to overwrite it.`);
    }
  }

  const payload = JSON.parse(await readFile(file, 'utf8'));
  const statements = buildImportStatements(payload);

  const counts = {};
  const lines = statements.map((stmt) => {
    const table = tableOf(stmt.sql);
    counts[table] = (counts[table] || 0) + 1;
    return renderStatement(stmt);
  });

  await writeFile(out, lines.join('\n') + '\n', 'utf8');

  console.log(`Wrote ${out}: ${statements.length} statements.`);
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table}: ${n}`);
  }
  if (payload.raw_html_keys?.length) {
    console.log(`\nNote: ${payload.raw_html_keys.length} raw_html_key(s) referenced in R2 are not restored by this script -- it writes D1 rows only.`);
  }
}

const argv = globalThis.process?.argv;
if (argv && typeof argv[1] === 'string' && argv[1].replace(/\\/g, '/').endsWith('scripts/import.mjs')) {
  await main().catch((err) => {
    console.error(String(err.message || err));
    globalThis.process.exitCode = 1;
  });
}
