import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release-engine.yml', import.meta.url), 'utf8'));
const action = (job, name) => job.steps.find(step => step.uses?.startsWith(`${name}@`));

describe('Linux engine release boundary', () => {
  test('builds only supported Linux targets and publishes checksums', () => {
    expect(workflow.jobs.build.strategy.matrix.include.map(target => target.short)).toEqual(['linux-x64', 'linux-arm64']);
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'publish']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.publish.needs).toBe('build');
    expect(workflow.jobs.publish.permissions).toEqual({ contents: 'write' });
    expect(workflow.jobs.publish.steps.find(step => step.name === 'Lay out release assets with checksums').run).toContain('sha256sum');
  });

  test('artifact downloads stay on the same-run runtime-token path', () => {
    for (const name of ['publish']) {
      const download = action(workflow.jobs[name], 'actions/download-artifact');
      // Supplying github-token opts into the public API path, which requires
      // separate Actions permissions and can read other workflow runs.
      for (const input of ['github-token', 'repository', 'run-id']) {
        expect(download.with[input]).toBeUndefined();
      }
    }
  });

  test('every third-party action is pinned to a commit', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      }
    }
  });
});
