'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const outDir = path.join(desktopDir, 'selftest');
const reportFile = path.join(outDir, 'report.json');
fs.rmSync(outDir, { recursive: true, force: true });

const exe = process.argv[2] || path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const args = process.argv[2] ? [] : [desktopDir];

console.log('Starting selftest:', exe, args.join(' '));
const child = spawn(exe, args, {
  cwd: desktopDir,
  env: { ...process.env, CREOMAKER_SELFTEST: outDir, CREOMAKER_SELFTEST_SHOW: '0' },
  stdio: 'ignore'
});

const start = Date.now();
const timer = setInterval(() => {
  if (fs.existsSync(reportFile)) {
    clearInterval(timer);
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {}
    const r = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    for (const c of r.checks || []) {
      console.log((c.pass ? 'PASS' : 'FAIL'), c.name, c.detail || '');
    }
    if (r.error) console.error('ERROR:', r.error);
    console.log('OVERALL OK =', r.ok, 'library =', JSON.stringify(r.library));
    process.exit(r.ok ? 0 : 1);
  }
  if (Date.now() - start > 75000) {
    clearInterval(timer);
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {}
    console.error('Selftest timed out after 45s');
    process.exit(2);
  }
}, 400);
