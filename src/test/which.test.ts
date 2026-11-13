import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExecutable } from '../which';

test('finds an executable on PATH', () => {
  const found = findExecutable('ls');
  assert.ok(typeof found === 'string' && found.length > 0);
  assert.ok(found.endsWith('ls'));
});

test('returns undefined for a missing command', () => {
  assert.equal(findExecutable('definitely-not-a-real-command-xyz'), undefined);
});

test('empty command', () => {
  assert.equal(findExecutable(''), undefined);
});

test('path-containing values must exist and be executable', () => {
  assert.equal(findExecutable('/bin/ls'), '/bin/ls');
  assert.equal(findExecutable('/no/such/file'), undefined);
  assert.equal(findExecutable('/etc/hosts'), undefined); // exists, not executable
});
