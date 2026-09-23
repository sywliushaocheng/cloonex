import fs from 'node:fs';
const sql = fs.readFileSync('src/db/schema.sql', 'utf8');
const esc = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const out = [
  '// AUTO-GENERATED from schema.sql by scripts/sync-schema.mjs — do not edit directly.',
  '// Applied idempotently on every database open.',
  '',
  'export const SCHEMA_SQL = `' + esc + '`;',
  '',
  'export const SCHEMA_VERSION = 1;',
  '',
].join('\n');
fs.writeFileSync('src/db/schema.ts', out, 'utf8');
console.log('schema.ts bytes=' + out.length);
