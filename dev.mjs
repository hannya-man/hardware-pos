// dev.mjs — one command for local development.
//
//   npm run dev                  Laravel API + Vite frontend together (Ctrl+C stops both)
//   npm run artisan -- <args>    any artisan command, e.g. npm run artisan -- migrate
//
// Plain `php` on this PC can be an old build (XAMPP's 8.0) that can't run
// Laravel 13, so this picks the newest PHP it finds that meets composer.json.
// Set PHP_BINARY to force a specific php.exe.
//
// The API port comes from VITE_API_BASE (the frontend's .env, or the
// environment, same as Vite). If that port is taken, say by another project,
// the next free one is used and Vite is told, so the frontend always talks
// to this server.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(ROOT, 'caidic-pos-laravel-fresh');
const WEB_DIR = path.join(ROOT, 'caidic-pos-frontend');
const WINDOWS = process.platform === 'win32';
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);

function fail(message) {
  console.error(paint('31', `\n✖ ${message}\n`));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Pick a PHP that can run this Laravel app
// ---------------------------------------------------------------------------

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map((n) => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

function phpVersion(bin) {
  try {
    return execFileSync(bin, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function findPhp() {
  const required = readFileSync(path.join(API_DIR, 'composer.json'), 'utf8').match(/"php"\s*:\s*"\D*(\d+\.\d+)/)?.[1] ?? '8.3';

  if (process.env.PHP_BINARY) {
    const version = phpVersion(process.env.PHP_BINARY);
    if (!version) fail(`PHP_BINARY is set to "${process.env.PHP_BINARY}", but it didn't run.`);
    return { bin: process.env.PHP_BINARY, version };
  }

  const exe = WINDOWS ? 'php.exe' : 'php';
  const downloads = path.join(os.homedir(), 'Downloads');
  const onPath = spawnSync(WINDOWS ? 'where' : 'which', WINDOWS ? ['php'] : ['-a', 'php'], { encoding: 'utf8' }).stdout ?? '';
  const candidates = new Set([
    ...onPath.split(/\r?\n/),
    ...(existsSync(downloads) ? readdirSync(downloads).filter((d) => /^php[-\d]/i.test(d)).map((d) => path.join(downloads, d, exe)) : []),
    path.join(os.homedir(), '.config', 'herd-lite', 'bin', exe),
  ]);

  const found = [...candidates]
    .filter((bin) => bin && existsSync(bin))
    .map((bin) => ({ bin, version: phpVersion(bin) }))
    .filter((php) => php.version)
    .sort((a, b) => compareVersions(b.version, a.version));

  if (!found.length || compareVersions(found[0].version, required) < 0) {
    const seen = found.map((p) => `${p.version} (${p.bin})`).join(', ') || 'none';
    fail(`Laravel needs PHP ${required} or newer. Found: ${seen}.\n  Install a newer PHP, or set PHP_BINARY to its php.exe.`);
  }
  return found[0];
}

// ---------------------------------------------------------------------------
// npm run artisan -- <args>
// ---------------------------------------------------------------------------

if (process.argv[2] === 'artisan') {
  const php = findPhp();
  const result = spawnSync(php.bin, ['artisan', ...process.argv.slice(3)], { cwd: API_DIR, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// npm run dev
// ---------------------------------------------------------------------------

function apiAddress() {
  const envFile = path.join(WEB_DIR, '.env');
  const fromFile = existsSync(envFile) ? readFileSync(envFile, 'utf8').match(/^\s*VITE_API_BASE\s*=\s*["']?([^"'\r\n]+)/m)?.[1] : null;
  const base = process.env.VITE_API_BASE ?? fromFile ?? 'http://localhost:8000/api';

  let url;
  try {
    url = new URL(base);
  } catch {
    fail(`VITE_API_BASE ("${base}") isn't a valid address. Check caidic-pos-frontend/.env.`);
  }
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
  const local = isIp || url.hostname === 'localhost';
  if (!local) console.log(paint('33', `Note: VITE_API_BASE points to ${url.hostname}, so the frontend won't use this local API.`));
  return { base, local, host: isIp ? url.hostname : '127.0.0.1', port: Number(url.port) || 8000 };
}

// Same address with a different port, keeping the original trailing slash (or not).
function withPort(base, port) {
  const url = new URL(base);
  url.port = String(port);
  return base.endsWith('/') ? url.href : url.href.replace(/\/$/, '');
}

const portIsFree = (port, host) => new Promise((resolve) => {
  const server = net.createServer()
    .once('error', () => resolve(false))
    .once('listening', () => server.close(() => resolve(true)))
    .listen(port, host);
});

const php = findPhp();
const api = apiAddress();
const vite = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

if (!existsSync(path.join(API_DIR, 'vendor', 'autoload.php'))) fail('Laravel packages are missing. Run "composer install" in caidic-pos-laravel-fresh.');
if (!existsSync(path.join(API_DIR, '.env'))) fail('caidic-pos-laravel-fresh/.env is missing. Copy .env.example to .env and fill it in.');
if (!existsSync(vite)) fail('Frontend packages are missing. Run: npm install --prefix caidic-pos-frontend');

const port = await (async () => {
  for (let p = api.port; p <= api.port + 20; p++) if (await portIsFree(p, api.host)) return p;
  fail(`Ports ${api.port} to ${api.port + 20} are all in use. Free one up, or change the port in VITE_API_BASE (caidic-pos-frontend/.env).`);
})();
if (port !== api.port) {
  console.log(paint('33', `Port ${api.port} is busy (another app is using it), so this API uses port ${port}. The frontend is pointed there automatically.`));
}

const children = new Set();
let exiting = false;
let exitCode = 0;

// Stops a process and everything it started (artisan serve runs a second php).
function stopTree(child) {
  if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
}

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  exitCode = code;
  children.forEach(stopTree);
  if (!children.size) process.exit(exitCode);
  setTimeout(() => process.exit(exitCode), 3000);
}

function start(name, color, command, args, cwd, env = {}) {
  const width = process.stdout.columns ? { COLUMNS: String(process.stdout.columns - 6) } : {};
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...width, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !WINDOWS, // its own process group on macOS/Linux, so stopTree reaches its children
  });
  const prefix = `${paint(color, name)} ${paint('2', '│')} `;
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => process.stdout.write(`${prefix}${line}\n`));
  }

  child.on('error', (err) => fail(`Couldn't start ${name}: ${err.message}`));
  child.on('exit', (code) => {
    children.delete(child);
    // Ctrl+C reaches every process at once, so give it a moment to register
    // before treating this exit as a crash.
    setTimeout(() => {
      if (exiting) {
        if (!children.size) process.exit(exitCode);
        return;
      }
      console.log(paint('31', `\n${name} stopped, so the other one is stopping too.`));
      shutdown(code > 0 && code < 256 ? code : 1); // a force-killed process reports odd codes like 4294967295
    }, 300);
  });
  children.add(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
if (WINDOWS) process.on('SIGBREAK', () => shutdown(0));

console.log(`
  ${paint('1', 'RRC Merchandise POS')} ${paint('2', '· development')}
  ${paint('34', 'api')}  Laravel  http://${api.host}:${port}  ${paint('2', `PHP ${php.version}`)}
  ${paint('35', 'web')}  Vite     address shows below
  ${paint('2', 'Ctrl+C stops both.')}
`);

start('api', '34', php.bin, ['artisan', 'serve', `--host=${api.host}`, `--port=${port}`, COLOR ? '--ansi' : '--no-ansi'], API_DIR);
start('web', '35', process.execPath, [vite], WEB_DIR, {
  ...(api.local ? { VITE_API_BASE: withPort(api.base, port) } : {}), // Vite prefers this over .env
  ...(COLOR ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' }),
});
