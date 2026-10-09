import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWindowsPathIntegration } from '../lib/platforms/windows/path-integration.js';

test('setup persists a session-only shim and never overwrites PATH after a failed read', () => {
  const calls=[];
  let stored='/windows-apps';
  let fail=false;
  const integration=createWindowsPathIntegration({
    pathDirPrecedesOriginal:()=>true,
    samePath:(a,b)=>a===b,
    uniquePaths:paths=>[...new Set(paths)],
    runPowerShell(script){calls.push(script);return {status:fail?1:0,stdout:stored};}
  });
  assert.equal(integration.ensureWindowsShimPath('/battery','/npm/codex.cmd').changed,true);
  assert.equal(calls.length,2);
  assert.match(calls[1],/SetEnvironmentVariable/);
  stored='/battery;/windows-apps';calls.length=0;
  assert.equal(integration.ensureWindowsShimPath('/battery','/npm/codex.cmd').changed,false);
  assert.equal(calls.length,1);
  fail=true;calls.length=0;
  assert.throws(()=>integration.ensureWindowsShimPath('/battery','/npm/codex.cmd'),/leaving it unchanged/);
  assert.equal(calls.length,1);
});
