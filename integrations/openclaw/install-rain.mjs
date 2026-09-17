#!/usr/bin/env node

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const integrationDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(integrationDir, 'rain-plugin');
const workspaceDir = join(integrationDir, 'rain-workspace');
const toolNames = [
  'get_my_identity',
  'get_my_daily_performance',
  'get_my_performance',
  'compare_my_performance',
  'get_my_tasks',
  'get_my_overdue_tasks',
];

function usage() {
  console.log(`Usage: node integrations/openclaw/install-rain.mjs [options]

Options:
  --erp-url <url>       RAHO ERP API origin (default: http://127.0.0.1:4000)
  --timeout-ms <ms>     ERP tool timeout, 1000-30000 (default: 8000)
  --config <path>       OpenClaw config path (default: OPENCLAW_CONFIG_PATH or ~/.openclaw/openclaw.json)
  --restart             Restart the OpenClaw gateway after validation
  --dry-run             Print the planned OpenClaw config operations without writing
  --help                Show this help

Run this command as the same OS user that owns and runs OpenClaw.`);
}

function parseArgs(argv) {
  const options = {
    erpUrl: 'http://127.0.0.1:4000',
    timeoutMs: 8000,
    configPath: process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw', 'openclaw.json'),
    restart: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') { usage(); process.exit(0); }
    if (arg === '--restart') { options.restart = true; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (['--erp-url', '--timeout-ms', '--config'].includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} membutuhkan nilai.`);
      i += 1;
      if (arg === '--erp-url') options.erpUrl = value;
      if (arg === '--timeout-ms') options.timeoutMs = Number(value);
      if (arg === '--config') options.configPath = value;
      continue;
    }
    throw new Error(`Argumen tidak dikenal: ${arg}`);
  }
  const url = new URL(options.erpUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('--erp-url harus berupa origin HTTP(S) tanpa username/password.');
  }
  options.erpUrl = url.origin;
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 30000) {
    throw new Error('--timeout-ms harus integer antara 1000 dan 30000.');
  }
  options.configPath = resolve(options.configPath);
  return options;
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} gagal dengan exit code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function readConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(`OpenClaw config tidak ditemukan: ${configPath}. Jalankan openclaw onboard terlebih dahulu.`);
  }
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function findRainIndex(config) {
  const list = config.agents?.list;
  if (!Array.isArray(list)) return -1;
  return list.findIndex((agent) => agent?.id === 'rain');
}

function buildOperations(config, rainIndex, options) {
  const currentPaths = Array.isArray(config.plugins?.load?.paths) ? config.plugins.load.paths : [];
  // Remove stale RAIN plugin paths when the repository was moved to a new host/path.
  const nonRainPaths = currentPaths.filter((entry) => basename(resolve(entry)) !== 'rain-plugin');
  const loadPaths = [...new Set([...nonRainPaths, pluginDir])];
  const existingPlugin = config.plugins?.entries?.['raho-ai'] || {};
  const existingPluginConfig = existingPlugin.config || {};
  return [
    { path: 'plugins.load.paths', value: loadPaths },
    {
      path: 'plugins.entries.raho-ai',
      value: {
        ...existingPlugin,
        enabled: true,
        config: { ...existingPluginConfig, baseUrl: options.erpUrl, timeoutMs: options.timeoutMs },
      },
    },
    { path: `agents.list[${rainIndex}].name`, value: 'RAIN' },
    { path: `agents.list[${rainIndex}].workspace`, value: workspaceDir },
    {
      path: `agents.list[${rainIndex}].identity`,
      value: { name: 'RAIN — Raho Artificial Intelligence Network', emoji: '📊' },
    },
    {
      path: `agents.list[${rainIndex}].tools`,
      value: { profile: 'minimal', alsoAllow: toolNames, deny: ['session_status'] },
    },
    { path: `agents.list[${rainIndex}].skills`, value: [] },
    { path: `agents.list[${rainIndex}].heartbeat`, value: { every: '0m' } },
    { path: 'gateway.http.endpoints.chatCompletions.enabled', value: true },
  ];
}

function ensureAgent(options) {
  let config = readConfig(options.configPath);
  let rainIndex = findRainIndex(config);
  if (rainIndex >= 0) return { config, rainIndex, created: false };
  if (options.dryRun) {
    const count = Array.isArray(config.agents?.list) ? config.agents.list.length : 0;
    return { config, rainIndex: count, created: true };
  }
  run('openclaw', ['agents', 'add', 'rain', '--workspace', workspaceDir, '--non-interactive', '--json']);
  config = readConfig(options.configPath);
  rainIndex = findRainIndex(config);
  if (rainIndex < 0) throw new Error('Agent rain tidak ditemukan setelah openclaw agents add.');
  return { config, rainIndex, created: true };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.OPENCLAW_CONFIG_PATH = options.configPath;
  run('openclaw', ['--version']);
  for (const requiredPath of [pluginDir, workspaceDir]) {
    if (!existsSync(requiredPath)) throw new Error(`Komponen RAIN tidak ditemukan: ${requiredPath}`);
  }
  let backupPath = null;
  if (!options.dryRun) {
    const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
    backupPath = `${options.configPath}.backup-rain-${stamp}`;
    copyFileSync(options.configPath, backupPath);
  }

  const { config, rainIndex, created } = ensureAgent(options);
  const operations = buildOperations(config, rainIndex, options);
  if (options.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      wouldCreateAgent: created,
      configPath: options.configPath,
      pluginDir,
      workspaceDir,
      operations,
    }, null, 2));
    return;
  }

  const temporaryDir = mkdtempSync(join(tmpdir(), 'rain-openclaw-install-'));
  const batchPath = join(temporaryDir, 'rain-config.batch.json');
  try {
    writeFileSync(batchPath, `${JSON.stringify(operations, null, 2)}\n`, { mode: 0o600 });
    run('openclaw', ['config', 'set', '--batch-file', batchPath]);
    run('openclaw', ['config', 'validate']);
    const tests = readdirSync(join(pluginDir, 'tests'))
      .filter((name) => name.endsWith('.test.js'))
      .map((name) => join(pluginDir, 'tests', name));
    run(process.execPath, ['--test', ...tests]);
    if (options.restart) run('openclaw', ['gateway', 'restart', '--safe']);
  } catch (error) {
    console.error(`Instalasi gagal. Backup config tersedia di ${backupPath}`);
    throw error;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }

  console.log('\nRAIN berhasil dikonfigurasi.');
  console.log(`Config backup : ${backupPath}`);
  console.log(`ERP base URL  : ${options.erpUrl}`);
  console.log(`Plugin        : ${pluginDir}`);
  console.log(`Workspace     : ${workspaceDir}`);
  if (!options.restart) console.log('Jalankan: openclaw gateway restart --safe');
  console.log('Lalu verifikasi: node integrations/openclaw/verify-rain.mjs');
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
