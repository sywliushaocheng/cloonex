import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the actual packed product outside the checkout, including migration.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-installed-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run test:install so the active npm executable is known.');
let client;
try {
  const env = { ...process.env, CLOONEX_CONFIG: path.join(temporary, 'config.json'), CLOONEX_DATA_DIR: path.join(temporary, 'data') };
  const npmRun = (...args) => execFileSync(process.execPath, [npm, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  npmRun('pack', '--pack-destination', temporary);
  const tarball = path.join(temporary, `cloonex-${manifest.version}.tgz`);
  const prefix = path.join(temporary, 'installed');
  npmRun('install', '--global', tarball, '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund');
  const packageRoot = process.platform === 'win32' ? path.join(prefix, 'node_modules/cloonex') : path.join(prefix, 'lib/node_modules/cloonex');
  const cli = path.join(packageRoot, 'dist/src/cli.js');
  assert.equal(fs.existsSync(path.join(packageRoot, 'node_modules/typescript')), false);
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: temporary, env, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(run('--version').trim(), manifest.version);
  run('init');
  const connection = JSON.parse(run('mcp-config', '--format', 'connection'));
  assert.ok(connection.args[0].startsWith(packageRoot.replaceAll('\\', '/')));
  const transport = new StdioClientTransport({ command: connection.command, args: connection.args, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'installed-package-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((item) => item.name === 'supersede_statement'));
  const result = await client.callTool({ name: 'data_info', arguments: { detail: true } });
  assert.ok(!result.isError);
  await client.close(); client = undefined;
  const archive = path.join(temporary, 'history.cloonex.gz');
  run('backup', 'export', '--out', archive);
  const target = path.join(temporary, 'new-computer');
  run('backup', 'import', archive, '--data-dir', target);
  assert.equal(JSON.parse(run('doctor', '--data-dir', target)).integrity, 'ok');
  run('install-skill', '--target', path.join(temporary, 'skills'));
  assert.ok(fs.existsSync(path.join(temporary, 'skills/cloonex/SKILL.md')));
  console.log(`Installed package ${manifest.version}: CLI, ${tools.tools.length} MCP tools, backup/import and skill passed.`);
} finally {
  await client?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
