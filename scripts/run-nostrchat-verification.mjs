import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2];
if (!['browser', 'tests'].includes(mode)) throw new Error('Choose browser or tests.');
const directory = process.argv[3] ? resolve(process.argv[3]) : resolve(root, '.data/nostrchat-checks', mode + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (!process.argv[3]) {
  const log = openSync(resolve(directory, 'output.log'), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, directory], { cwd: root, env: process.env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log); child.unref();
  console.log(JSON.stringify({ pid: child.pid, directory, classification: mode === 'browser' ? 'Private-regtest browser acceptance only, no public messages or real-value payments.' : 'Isolated automated tests only.' }));
} else {
  const report = { mode, status: 'running', startedAt: new Date().toISOString(), exitCode: null };
  const persist = () => writeFileSync(resolve(directory, 'status.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  persist();
  report.exitCode = await new Promise(done => {
    const child = spawn('pnpm', [mode === 'browser' ? 'verify:nostrchat:ui' : 'test'], { cwd: root, env: process.env, stdio: 'inherit' });
    child.on('error', () => done(1)); child.on('exit', (code, signal) => done(code ?? (signal ? 143 : 1)));
  });
  report.status = report.exitCode === 0 ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString(); persist();
}
