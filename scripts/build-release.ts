import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const status = await new Promise<number | null>((done, reject) => {
  const child = spawn('pnpm', ['build', '--', 'nostrchat'], {stdio:'inherit', env:{...process.env,SATS_BUILD_BASE:'/'}});
  child.on('error', reject); child.on('exit', done);
});
if (status !== 0) process.exit(status || 1);
const output = resolve('dist');
rmSync(output, {recursive:true,force:true}); mkdirSync(output, {recursive:true});
cpSync(resolve('apps/nostrchat/dist'), output, {recursive:true});
console.log('NostrChat standalone build ready.');
