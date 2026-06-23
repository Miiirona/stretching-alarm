/**
 * Dev launcher: starts Vite, reads the actual port from its stdout,
 * then spawns Electron with VITE_DEV_SERVER_URL set dynamically.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin     = path.join(root, 'node_modules', '.bin', 'vite');
const electronBin = path.join(root, 'node_modules', '.bin', 'electron');

let electronProc = null;
let started  = false;
let exiting  = false;

// ── Vite ──────────────────────────────────────────────────────────────────────
const viteProc = spawn(viteBin, [], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`\x1b[36m[VITE]\x1b[0m ${text}`);

  if (started) return;

  // Strip ANSI codes before matching (Vite colorizes output)
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const match = plain.match(/Local:\s+(http:\/\/localhost:\d+)/);
  if (match) {
    started = true;
    launchElectron(match[1]);
  }
});

viteProc.stderr.on('data', (chunk) => {
  process.stderr.write(`\x1b[36m[VITE]\x1b[0m ${chunk}`);
});

viteProc.on('exit', (code) => {
  if (exiting) return;
  exiting = true;
  electronProc?.kill();
  process.exit(code ?? 0);
});

// ── Electron ──────────────────────────────────────────────────────────────────
function launchElectron(devUrl) {
  console.log(`\x1b[33m[ELECTRON]\x1b[0m Vite ready at ${devUrl} → launching Electron`);

  electronProc = spawn(electronBin, ['.'], {
    cwd: root,
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
    stdio: 'inherit',
  });

  electronProc.on('exit', (code) => {
    if (exiting) return;
    exiting = true;
    viteProc.kill();
    process.exit(code ?? 0);
  });
}

// ── Cleanup on Ctrl-C ─────────────────────────────────────────────────────────
function shutdown() {
  if (exiting) return;
  exiting = true;
  viteProc.kill();
  electronProc?.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
