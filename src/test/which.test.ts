import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExecutable } from '../which';

const isWin = process.platform === 'win32';

test('finds an executable on PATH', () => {
  const found = findExecutable(isWin ? 'where' : 'ls');
  assert.ok(typeof found === 'string' && found.length > 0);
  assert.ok(found.toLowerCase().endsWith(isWin ? 'where.exe' : 'ls'));
});

test('returns undefined for a missing command', () => {
  assert.equal(findExecutable('definitely-not-a-real-command-xyz'), undefined);
});

test('empty command', () => {
  assert.equal(findExecutable(''), undefined);
});

test('path-containing values must exist and be executable', () => {
  if (isWin) {
    // Windows has no mode bits: every existing regular file counts.
    assert.equal(
      findExecutable('C:\\Windows\\System32\\where.exe'),
      'C:\\Windows\\System32\\where.exe',
    );
    assert.equal(findExecutable('C:\\no\\such\\file'), undefined);
  } else {
    assert.equal(findExecutable('/bin/ls'), '/bin/ls');
    assert.equal(findExecutable('/no/such/file'), undefined);
    assert.equal(findExecutable('/etc/hosts'), undefined); // exists, not executable
  }
});

test('absolute path to a known executable resolves', () => {
  // process.execPath is the running node binary — always an executable file.
  assert.equal(findExecutable(process.execPath), process.execPath);
});
