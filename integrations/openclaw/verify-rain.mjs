#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const integrationDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(integrationDir, 'rain-plugin');
const workspaceDir = join(integrationDir, 'rain-workspace');
const requiredTools = [
  'get_my_identity',
  'get_my_daily_performance',
  'get_my_performance',
  'compare_my_performance',
  'get_my_tasks',
  'get_my_overdue_tasks',
];

function parseArgs(argv) {
  let configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw', 'openclaw.json');
  let configOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config-only') { configOnly = true; continue; }
    if (argv[i] === '--config') {
      if (!argv[i + 1]) throw new Error('--config membutuhkan path.');
      configPath = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Argumen tidak dikenal: ${argv[i]}`);
  }
  return { configPath: resolve(configPath), configOnly };
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} gagal: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assert(existsSync(options.configPath), `Config tidak ditemukan: ${options.configPath}`);
  const config = JSON.parse(readFileSync(options.configPath, 'utf8'));
  const rain = config.agents?.list?.find((agent) => agent?.id === 'rain');
  assert(rain, 'Agent rain belum terdaftar.');
  assert(resolve(rain.workspace) === resolve(workspaceDir), `Workspace rain tidak menunjuk ke ${workspaceDir}`);
  assert(rain.tools?.profile === 'minimal', 'Tool profile rain harus minimal.');
  for (const tool of requiredTools) {
    assert(rain.tools?.alsoAllow?.includes(tool), `Tool ${tool} belum diizinkan.`);
  }
  assert(rain.skills?.length === 0, 'RAIN tidak boleh memuat skill tambahan pada V1.');
  assert(rain.heartbeat?.every === '0m', 'Heartbeat RAIN harus nonaktif pada V1.');

  const plugin = config.plugins?.entries?.['raho-ai'];
  assert(plugin?.enabled === true, 'Plugin raho-ai belum aktif.');
  assert(config.plugins?.load?.paths?.map(resolve).includes(resolve(pluginDir)), 'Path plugin RAIN belum terdaftar.');
  const baseUrl = new URL(plugin.config?.baseUrl);
  assert(['http:', 'https:'].includes(baseUrl.protocol), 'ERP base URL harus HTTP(S).');
  assert(!baseUrl.username && !baseUrl.password, 'ERP base URL tidak boleh mengandung credential.');
  assert(Number.isInteger(plugin.config?.timeoutMs), 'timeoutMs plugin belum valid.');
  assert(config.gateway?.http?.endpoints?.chatCompletions?.enabled === true, 'OpenAI-compatible chat completions belum aktif.');

  run('openclaw', ['config', 'validate']);
  const tests = readdirSync(join(pluginDir, 'tests'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => join(pluginDir, 'tests', name));
  run(process.execPath, ['--test', ...tests]);
  if (!options.configOnly) {
    const gateway = run('openclaw', ['gateway', 'status'], { allowFailure: true });
    assert(gateway.status === 0, `Gateway belum sehat: ${(gateway.stderr || gateway.stdout).trim()}`);
  }

  console.log(JSON.stringify({
    ok: true,
    agent: 'rain',
    plugin: 'raho-ai',
    erpBaseUrl: baseUrl.origin,
    timeoutMs: plugin.config.timeoutMs,
    tools: requiredTools,
    gatewayChecked: !options.configOnly,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`VERIFY FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
