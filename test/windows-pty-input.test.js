import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureWindowsPtyInput } from '../lib/platforms/windows/codex-runner.js';

test('ConPTY input uses blocking writes and rejects unsafe transport before attaching input', () => {
  let mode;
  configureWindowsPtyInput({_agent:{inSocket:{_handle:{setBlocking(value){mode=value;return 0;}}}}});
  assert.equal(mode,true);
  assert.throws(()=>configureWindowsPtyInput({}),/cannot be configured safely/);
  assert.throws(()=>configureWindowsPtyInput({_agent:{inSocket:{_handle:{setBlocking(){return -1;}}}}}),/configuration failed/);
});
