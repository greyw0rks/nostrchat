import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const apiPort = Number(process.env.SATS_API_PORT || 4424);
const webPort = Number(process.env.SATS_CHAT_PORT || 4405);
const data = resolve(process.env.SATS_DATA_DIR || '.data/chat-preview');
for (const port of [apiPort, webPort]) if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose valid local preview ports.');
mkdirSync(data, { recursive: true, mode: 0o700 });
const environment = { ...process.env, SATS_API_PORT: String(apiPort), SATS_CHAT_PORT: String(webPort), SATS_API_ORIGIN: 'http://127.0.0.1:' + apiPort, SATS_DATA_DIR: data };
const api = 'http://127.0.0.1:' + apiPort;
const web = 'http://127.0.0.1:' + webPort;
async function healthy(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
function launch(name, args) {
  const log = openSync(resolve(data, name + '.log'), 'a', 0o600);
  try {
    const child = spawn('pnpm', ['exec', ...args], { cwd: root, env: environment, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    return child.pid;
  } finally { closeSync(log); }
}
const pids = {};
if (!await healthy(api + '/api/health')) pids.api = launch('api', ['tsx', 'server/index.ts']);
else {
  const health = await (await fetch(api + '/api/health')).json();
  if (health.chatWalletIsolated !== true) throw new Error('This API port belongs to a different release. Choose an unused SATS_API_PORT.');
}
if (!process.argv.includes('--api-only') && !await healthy(web + '/')) pids.web = launch('web', ['vite', resolve(root, 'apps/nostrchat'), '--config', resolve(root, 'apps/nostrchat/vite.config.ts')]);
for (let attempt = 0; attempt < 100; attempt++) {
  if (await healthy(api + '/api/chat/config') && (process.argv.includes('--api-only') || await healthy(web + '/'))) {
    const runtime = { startedAt: new Date().toISOString(), api, web, pids, dataDirectory: data, classification: 'Private local product preview. No video render, wallet payment, or public message publication.' };
    writeFileSync(resolve(data, 'runtime.json'), JSON.stringify(runtime, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(runtime));
    process.exit(0);
  }
  await new Promise(done => setTimeout(done, 250));
}
throw new Error('The chat preview did not become ready. Check its private local logs.');
