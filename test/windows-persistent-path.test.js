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

test('uninstall removes only owned Windows PATH entries without normalizing other bytes', () => {
  const calls=[];
  const integration=createWindowsPathIntegration({
    uniquePaths:paths=>[...new Set(paths)],
    runPowerShell(script){calls.push(script);return {status:0,stdout:'C:\\Apps;; C:\\Keep ;C:\\Battery;D:\\Other;\r\n'};}
  });
  assert.deepEqual(integration.removeWindowsUserPathEntries(['C:\\Battery']),['Windows user PATH']);
  assert.equal(calls[1],"[Environment]::SetEnvironmentVariable('Path', 'C:\\Apps;; C:\\Keep ;D:\\Other;', 'User')");
});

test('uninstall reports a failed Windows PATH write instead of claiming success', () => {
  let calls=0;
  const integration=createWindowsPathIntegration({
    uniquePaths:paths=>paths,
    runPowerShell(){return {status:++calls===1?0:1,stdout:'/battery;/keep'};}
  });
  assert.throws(()=>integration.removeWindowsUserPathEntries(['/battery']),/kept the recovery record/);
});
