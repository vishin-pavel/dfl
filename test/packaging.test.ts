import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let packed: Set<string> | undefined;

/** The paths `npm pack` would publish (computed once). */
function packedFiles(): Set<string> {
  packed ??= new Set(
    (
      JSON.parse(
        execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      ) as Array<{ files: Array<{ path: string }> }>
    )[0]!.files.map((file) => file.path),
  );
  return packed;
}

function distTag(...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/publish-tag.mjs'), ...args], { encoding: 'utf8' });
  return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

describe('publish dist-tag (F82)', () => {
  it('publishes prereleases under next and releases under latest', () => {
    for (const version of ['0.2.0-rc.1', '1.0.0-beta.0', '1.0.0-0', '2.0.0-alpha.1+build.5']) {
      expect(distTag(version), version).toMatchObject({ code: 0, stdout: 'next' });
    }
    for (const version of ['0.1.0', '1.0.0', '1.0.0+build-1', '10.20.30']) {
      expect(distTag(version), version).toMatchObject({ code: 0, stdout: 'latest' });
    }
    // A GitHub release marked as prerelease goes to next even without a prerelease version.
    expect(distTag('1.0.0', '--prerelease')).toMatchObject({ code: 0, stdout: 'next' });
  });

  it('refuses something that is not a version', () => {
    for (const args of [['v1.0.0'], ['1.0'], ['01.0.0'], []]) {
      const result = distTag(...args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stdout).toBe('');
    }
  });

  it('the publish workflow passes the chosen dist-tag to npm publish', () => {
    const workflow = parseYaml(read('.github/workflows/publish.yml')) as {
      jobs: { publish: { env: Record<string, string>; steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }> } };
    };
    const job = workflow.jobs.publish;
    // setup-node v7 no longer exports a placeholder token: npm ci and npm publish need it from the job.
    expect(job.env['NODE_AUTH_TOKEN']).toBe('${{ secrets.GITHUB_TOKEN }}');
    const uses = job.steps.map((step) => step.uses).filter(Boolean);
    expect(uses).toEqual(['actions/checkout@v7', 'actions/setup-node@v7']);
    const choose = job.steps.find((step) => step.name === 'Choose the dist-tag');
    expect(choose?.run).toContain('node scripts/publish-tag.mjs');
    const publish = job.steps.find((step) => step.name === 'Publish');
    expect(publish?.run).toBe('npm publish --tag "${DIST_TAG}"');
    expect(publish?.env?.['DIST_TAG']).toBe('${{ steps.dist.outputs.tag }}');
    // The script runs before npm ci, so it must not need dependencies.
    const order = job.steps.map((step) => step.name ?? step.run ?? step.uses);
    expect(order.indexOf('Choose the dist-tag')).toBeLessThan(order.indexOf('npm ci'));
    expect(read('scripts/publish-tag.mjs')).not.toMatch(/from '(?!node:)/);
  });

  it('CI uses the current action majors', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/actions\/(checkout|setup-node)@v[0-6]\b/);
    expect(ci).toContain('actions/checkout@v7');
    expect(ci).toContain('actions/setup-node@v7');
  });
});

describe('published README (F87)', () => {
  it('links only to files that ship in the package, or to absolute URLs', () => {
    const files = packedFiles();
    expect(files.has('README.md')).toBe(true);
    const readme = read('README.md');
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      const target = link.replace(/#.*$/, '').replace(/^\.\//, '');
      expect(files.has(target), `README links to ${link}, which is not in the package`).toBe(true);
    }
    // The docs are not shipped: they are linked on GitHub.
    expect(readme).toContain('https://github.com/vishin-pavel/dfl/blob/main/docs/AGENTS.md');
    expect(readme).toContain('https://github.com/vishin-pavel/dfl/blob/main/docs/ARCHITECTURE.md');
  });
});

describe('package contents', () => {
  it('ships the "dev" flow template only; the retired templates are test fixtures', () => {
    const files = [...packedFiles()];
    expect(files).toContain('templates/flows/dev/flow.json');
    const flowTemplates = new Set(files.filter((file) => file.startsWith('templates/flows/')).map((file) => file.split('/')[2]));
    expect([...flowTemplates]).toEqual(['dev']);
    expect(files.filter((file) => file.startsWith('test/'))).toEqual([]);
    for (const name of ['feature', 'bugfix', 'quick']) expect(fs.existsSync(path.join(ROOT, 'test/fixtures/flows', name, 'flow.json')), name).toBe(true);
  });
});
