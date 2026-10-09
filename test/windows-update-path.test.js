import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Windows Codex launch and npm update match the original launcher across PATH switches', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-battery-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateNode = path.join(process.env.LOCALAPPDATA, 'ai-battery/runtimes/node-v24.21.0-win-x64/node.exe');
  const host = fs.existsSync(privateNode) ? privateNode : process.execPath;
  const dirs = ['active', 'old'].map(n => path.join(root, n));
  for (const [i, dir] of dirs.entries()) {
    fs.mkdirSync(dir);
    fs.copyFileSync(i ? host : process.execPath, path.join(dir, 'node.exe'));
    fs.writeFileSync(path.join(dir, 'version'), '1');
    fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\nset "dp0=%~dp0"\r\nif exist "%dp0%node.exe" (set "prog=%dp0%node.exe") else (set "prog=node")\r\n"%prog%" "%dp0%codex.cjs" %*\r\n');
    fs.writeFileSync(path.join(dir, 'npm.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0npm.cjs" %*\r\n');
    fs.writeFileSync(path.join(dir, 'npm.cjs'), 'const fs=require("fs");fs.writeFileSync(__dirname+"/version","2");console.log(__dirname);');
    fs.writeFileSync(path.join(dir, 'codex.cjs'), 'const fs=require("fs"),cp=require("child_process");const npm=cp.spawnSync("cmd.exe",["/d","/c",process.argv.includes("update")?"npm install -g @openai/codex":"where npm.cmd"],{encoding:"utf8"});if(npm.status)process.exit(npm.status);console.log(JSON.stringify({node:process.execPath,path:process.env.PATH,npm:npm.stdout.trim(),version:fs.readFileSync(__dirname+"/version","utf8")}));');
  }
  const launcher = new URL('../bin/codex-wrapper-win.cjs', import.meta.url).href;
  const runner = new URL('../lib/platforms/windows/codex-runner.js', import.meta.url).href;
  const probe = path.join(root, 'probe.mjs');
  fs.writeFileSync(probe, `import launcher from ${JSON.stringify(launcher)};import {windowsCommand} from ${JSON.stringify(runner)};import {spawnSync} from 'node:child_process';const codex=launcher.findWindowsPathCommand('codex');if(!codex)process.exit(127);const c=windowsCommand([codex,...process.argv.slice(2)]);const r=spawnSync(c.file,c.args,{encoding:'utf8',env:process.env});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`);
  for (const order of [dirs, [...dirs].reverse()]) {
    const env = { ...process.env, PATH: [...order, path.join(process.env.SystemRoot, 'System32')].join(';') };
    const run = (wrapped, args=[]) => {
      const r=wrapped ? spawnSync(host,[probe,...args],{env,encoding:'utf8'})
        : spawnSync('cmd.exe',['/d','/c', 'codex',...args],{env,encoding:'utf8'});
      assert.equal(r.status,0,r.stderr);
      return JSON.parse(r.stdout.trim());
    };
    fs.writeFileSync(path.join(order[0],'version'),'1');
    assert.deepEqual(run(true),run(false));
    const normal=run(false,['update']);
    fs.writeFileSync(path.join(order[0],'version'),'1');
    assert.deepEqual(run(true,['update']),normal);
    assert.equal(run(true).version,'2');
    assert.deepEqual(run(true),run(false));
  }
  // A private display runtime must not rescue npm Codex when PATH has no Node.
  fs.rmSync(path.join(dirs[0],'node.exe'));
  fs.rmSync(path.join(dirs[1],'node.exe'));
  const env={...process.env,PATH:dirs[0]+';'+path.join(process.env.SystemRoot,'System32')};
  assert.notEqual(spawnSync('cmd.exe',['/d','/c','codex'],{env,encoding:'utf8'}).status,0);
  assert.notEqual(spawnSync(host,[probe],{env,encoding:'utf8'}).status,0);
});
