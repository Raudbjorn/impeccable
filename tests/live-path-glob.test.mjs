import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { livePathGlobToRegex } from '../skill/scripts/lib/live-path-globs.mjs';

describe('livePathGlobToRegex', () => {
  function match(pattern, path) {
    return livePathGlobToRegex(pattern).test(path);
  }

  it('anchors exact matches', () => {
    assert.ok(match('src/App.tsx', 'src/App.tsx'));
    assert.ok(!match('src/App.tsx', 'App.tsx'));
    assert.ok(!match('src/App.tsx', 'src/App.tsx/extra'));
  });

  it('* does not cross path separators', () => {
    // *.tsx matches a single-segment filename
    assert.ok(match('*.tsx', 'App.tsx'));
    assert.ok(match('*.tsx', 'Button.tsx'));
    // *.tsx does not match multi-segment paths
    assert.ok(!match('*.tsx', 'components/Button.tsx'));
    assert.ok(!match('*.tsx', 'src/components/Button.tsx'));
  });

  it('** crosses path separators', () => {
    assert.ok(match('**/*.tsx', 'App.tsx'));
    assert.ok(match('**/*.tsx', 'Button.tsx'));
    assert.ok(match('**/*.tsx', 'components/Button.tsx'));
    assert.ok(match('**/*.tsx', 'src/components/Button.tsx'));
  });

  it('** without trailing / anchors at start only', () => {
    assert.ok(match('src/**', 'src/App'));
    assert.ok(match('src/**', 'src/components/Button'));
    assert.ok(!match('src/**', 'App'));
    assert.ok(!match('src/**', 'src2/Button'));
  });

  it('? matches one character', () => {
    assert.ok(match('src/?.tsx', 'src/a.tsx'));
    assert.ok(match('src/?.tsx', 'src/x.tsx'));
    assert.ok(!match('src/?.tsx', 'src/ab.tsx'));
    assert.ok(!match('src/?.tsx', 'src/.tsx'));
  });

  it('escapes regex special characters', () => {
    assert.ok(match('src/app.test.tsx', 'src/app.test.tsx'));
    assert.ok(!match('src/app.test.tsx', 'src/appXtest.tsx'));
    assert.ok(!match('src/app.test.tsx', 'src/app-test.tsx'));
    assert.ok(match('src/app[1].tsx', 'src/app[1].tsx'));
  });

  it('handles empty pattern', () => {
    assert.ok(livePathGlobToRegex('').test(''));
    assert.ok(!livePathGlobToRegex('').test('x'));
  });

  it('multiple ** segments work', () => {
    assert.ok(match('src/**/components/**/*.tsx', 'src/a/b/components/x/y/Button.tsx'));
    assert.ok(!match('src/**/components/**/*.tsx', 'components/Button.tsx'));
  });
});
