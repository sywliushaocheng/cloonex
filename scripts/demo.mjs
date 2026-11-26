import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// An executable example using real MCP calls. All data lives in a new temporary
// directory; neither the user's knowledge base nor Codex settings are touched.
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(repoRoot, 'dist/src/mcp/server.js');
if (!fs.existsSync(entry)) throw new Error('Run npm run build first, or use npm run demo.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('Usage: node scripts/demo.mjs [--output transcript.json]');
}
const outputFile = args.length ? path.resolve(args[1]) : null;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-demo-'));
const projectRoot = path.join(temporaryRoot, 'order-app');
const dataDir = path.join(temporaryRoot, 'knowledge');
const sourceFile = path.join(projectRoot, 'src/export.mjs');
fs.cpSync(path.join(repoRoot, 'examples/order-export'), projectRoot, { recursive: true });
const steps = [];
let client;

function show(title, lines) {
  steps.push({ title, lines });
  process.stdout.write(`\n${steps.length}. ${title}\n${lines.map((line) => `   ${line}`).join('\n')}\n`);
}

async function connect() {
  const next = new Client({ name: 'cloonex-demo', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, CLOONEX_DATA_DIR: dataDir },
    stderr: 'pipe',
  });
  // Drain diagnostic output without writing private paths into the transcript.
  transport.stderr?.on('data', () => {});
  try {
    await next.connect(transport);
    return next;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

async function call(name, input, allowError = false) {
  const response = await client.callTool({ name, arguments: input });
  const body = JSON.parse(response.content.find((item) => item.type === 'text').text);
  if (response.isError && !allowError) throw new Error(`${name}: ${body.error}`);
  return { body, rejected: response.isError === true };
}

try {
  client = await connect();
  await call('project_init', { rootPath: projectRoot, name: 'Order export demo' });
  await call('project_add_convention', {
    projectRoot, category: 'scope', content: 'Do not fetch unloaded pages.', source: 'requirements.md (fictional example)',
  });
  const { body: begun } = await call('begin_task', {
    projectRoot, title: 'Export current-page order IDs', taskType: 'feature', featureSlug: 'order-export',
    intent: 'Export the rows already loaded on the current page.',
    outOfScope: 'Fetching other pages or adding server-side export jobs.',
    doneCriteria: 'The example serializer returns the two loaded order IDs.',
  });
  const taskId = begun.task.id;
  const { body: context } = await call('get_context', { taskId });
  assert.ok(context.sections.some((section) => section.items.some((item) => item.includes('Do not fetch unloaded pages.'))));
  show('Keep the task in scope', [
    '> begin_task / get_context',
    `intent: ${context.task.intent}`,
    'convention loaded: Do not fetch unloaded pages.',
  ]);

  const { body: recorded } = await call('record_decision', {
    taskId, featureSlug: 'order-export', title: 'Export scope', choice: 'Current page only',
    reason: 'Keep the initial implementation small; do not fetch other pages.', reasonSource: 'external_doc',
    evidence: [{ kind: 'doc', relativePath: 'requirements.md', note: 'Fictional example requirements.' }],
  });
  const sampleModule = await import(pathToFileURL(sourceFile).href);
  assert.equal(sampleModule.exportOrderIds([{ id: 'ORD-101' }, { id: 'ORD-102' }]), 'ORD-101,ORD-102');
  const { body: finalized } = await call('finalize_task', {
    taskId, outcome: 'The example serializer was checked against two loaded rows.',
    verification: 'Imported src/export.mjs and asserted output ORD-101,ORD-102.',
    feature: { slug: 'order-export', title: 'Order export', purpose: 'Export loaded order IDs.' },
    statements: [{
      featureSlug: 'order-export', section: 'implementation',
      content: 'src/export.mjs serializes the IDs of the supplied current-page rows.',
      relativePaths: ['src/export.mjs'],
    }],
  });
  assert.equal(finalized.result.codeState.length, 1);
  show('Save the decision with evidence', [
    '> record_decision / finalize_task',
    `choice: ${recorded.decision.choice}`,
    `reason source: ${recorded.decision.reasonSource} (sample requirements)`,
    `file fingerprints saved: ${finalized.result.codeState.length}`,
  ]);

  // A second MCP process proves that retrieval comes from the local database,
  // rather than the state of the first client connection.
  await client.close();
  client = undefined;
  client = await connect();
  const { body: queried } = await call('query_feature', { projectRoot, query: 'order-export', includeHistory: true });
  assert.equal(queried.found, true);
  const decision = queried.dossier.decisions.find((item) => item.title === 'Export scope');
  assert.equal(decision.choice, 'Current page only');
  assert.equal(decision.reasonSource, 'external_doc');
  show('Reconnect and recover the reason', [
    '> query_feature (new MCP process, same database)',
    `feature found: ${queried.found}`,
    `choice: ${decision.choice}`,
    `reason: ${decision.reason}`,
  ]);

  const { body: before } = await call('stale_check', { projectRoot });
  assert.equal(before.staleCount, 0);
  fs.appendFileSync(sourceFile, '\n// A later edit changed this linked file.\n', 'utf8');
  const { body: after } = await call('stale_check', { projectRoot });
  assert.equal(after.staleCount, 1);
  const changedEvidence = after.reports.flatMap((report) => report.evidence).find((item) => item.status === 'changed');
  assert.equal(changedEvidence.relativePath, 'src/export.mjs');
  show('Check again after a file edit', [
    '> stale_check (explicit check, no background watcher)',
    `before edit: ${before.staleCount} statements need review`,
    `after edit: ${after.staleCount} statement needs review`,
    `linked file: ${changedEvidence.relativePath} (${changedEvidence.status})`,
  ]);

  const { body: bugfix } = await call('begin_task', { projectRoot, title: 'Example bug fix', taskType: 'bugfix' });
  const { body: bugfixContext } = await call('get_context', { taskId: bugfix.task.id });
  assert.ok(bugfixContext.sections.some((section) => section.items.some((item) => item.includes('Do not fetch unloaded pages.'))));
  const blocked = await call('propose_preference', {
    taskId: bugfix.task.id, title: 'A rule from a bug fix', content: 'This write must be refused.', scope: 'project',
  }, true);
  assert.equal(blocked.rejected, true);
  const { body: preferences } = await call('manage_preference', { action: 'list' });
  assert.equal(preferences.preferences.length, 0);
  await call('finalize_task', { taskId: bugfix.task.id, outcome: 'Verified that preference writes are refused.' });
  show('Enforce the learning boundary', [
    '> propose_preference (bugfix task)',
    `write rejected: ${blocked.rejected}`,
    'Existing context remains readable; no preference was saved.',
  ]);

  if (outputFile) {
    // Public artifact: only selected, asserted facts; no machine paths or IDs.
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify({
      kind: 'Real MCP output replay', scenario: 'Fictional order-export fixture',
      command: 'npm run demo', steps,
    }, null, 2)}\n`, 'utf8');
  }
  process.stdout.write('\nDemo passed. The isolated example data is removed on exit.\n');
} finally {
  try {
    await client?.close();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
