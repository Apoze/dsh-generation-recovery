import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('bundle exports the runtime, metadata and exactly one stable loader entry', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.equal((patch.match(/- id:/g) ?? []).length, 1);
  assert.ok(patch.includes('id: generation-recovery'));
  assert.ok(patch.includes('name: dsh-generation-recovery'));
  assert.doesNotMatch(patch, /Users|192\.168\.|api[_-]?key/i);
  const runtime = typeof pkg.exports['.'] === 'string' ? pkg.exports['.'] : pkg.exports['.'].default;
  assert.doesNotThrow(() => readFileSync(new URL('../' + runtime, import.meta.url)));
});
