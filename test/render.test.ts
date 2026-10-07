import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DflError } from '../src/core/errors.js';
import { loadFlow } from '../src/core/flow.js';
import { packageVersion } from '../src/core/paths.js';
import {
  buildTemplateContext,
  builtinSkillEnabled,
  builtinSkillNames,
  createHandlebars,
  dflCliCommand,
  firstSymlinkBetween,
  isRenderedOutputPath,
  normalizeSkillMarkdown,
  readRenderedOutputs,
  renderBuiltinSkills,
  renderFlow,
  renderFlowSkills,
  renderTemplate,
  slashCommandTokens,
} from '../src/core/render.js';
import type { ProjectPaths, RenderedSkill, TemplateContext } from '../src/core/types.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, writeSampleFlow } from './helpers/project.js';

afterEach(cleanupTempDirs);

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sampleProject(): ProjectPaths {
  const paths = makeTempProject();
  writeSampleFlow(paths);
  return paths;
}

function render(source: string, context: Partial<TemplateContext> & Record<string, unknown> = {}): string {
  return renderTemplate(createHandlebars(), source, context as TemplateContext, 'inline.hbs');
}

/** Splits a rendered SKILL.md into its parsed frontmatter and body. */
function splitSkill(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)---\n\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`no frontmatter in:\n${text}`);
  return { data: parseYaml(match[1]!) as Record<string, unknown>, body: match[2]! };
}

function flowContextSection(text: string): string {
  const start = text.indexOf('## Flow context');
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start).trimEnd();
}

/** Tokens that Claude Code / OpenCode expand when a skill runs as a slash command. */
function expectNoSlashCommandTokens(text: string): void {
  expect(text).not.toMatch(/\$ARGUMENTS|\$\d/);
  expect(text).not.toMatch(/^!`/m);
  expect(text).not.toMatch(/(^|[\s(])@\w/m);
}

function skillFile(skill: RenderedSkill, file: string): string {
  const found = skill.files.find((f) => f.path === file);
  if (found?.content === undefined) throw new Error(`${file} not rendered for ${skill.name}`);
  return found.content;
}

describe('helpers', () => {
  it('provides variadic logic helpers, inline and as blocks', () => {
    const ctx = { a: 1, b: 1, c: 2, list: [], full: [1], yes: true, no: false };
    expect(render('{{eq a b}} {{eq a b c}} {{ne a c}} {{ne a b}}', ctx)).toBe('true false true false');
    expect(render('{{and yes a full}} {{and yes list}} {{or no list a}} {{or no list}}', ctx)).toBe('true false true false');
    expect(render('{{not no}} {{not no list}} {{not no yes}}', ctx)).toBe('true true false');
    expect(render('{{#if (and (eq a 1) (not no))}}ok{{/if}}', ctx)).toBe('ok');
    expect(render('{{#eq a c}}same{{else}}different{{/eq}}', ctx)).toBe('different');
  });

  it('provides string, json, join, indent and command helpers', () => {
    const ctx = { name: 'Plan Feature', empty: '', items: ['a', 'b'], obj: { x: 1 }, text: 'one\n\ntwo' };
    expect(render('{{default missing "fb"}} {{default empty "fb"}} {{default name "fb"}}', ctx)).toBe('fb fb Plan Feature');
    expect(render('{{upper name}} {{lower name}} {{kebab name}} {{title "plan-feature"}}', ctx)).toBe(
      'PLAN FEATURE plan feature plan-feature Plan Feature',
    );
    expect(render('{{json obj}}|{{json obj 0}}', ctx)).toBe('{\n  "x": 1\n}|{"x":1}');
    expect(render('{{join items}}|{{join items " / "}}', ctx)).toBe('a, b|a / b');
    expect(render('{{indent 2 text}}', ctx)).toBe('  one\n\n  two');
    expect(render('{{#indent 4}}x\ny{{/indent}}', ctx)).toBe('    x\n    y');
    expect(render('{{command "plan-feature"}}', ctx)).toBe('/plan-feature');
    expect(render('[{{handle " @@OctoCat "}}][{{handle "octocat"}}][{{handle missing}}]', ctx)).toBe('[OctoCat][octocat][]');
  });

  it('keeps bare property references that share a helper name working', () => {
    expect(render('{{#each items}}{{title}}:{{upper title}};{{/each}}', { items: [{ title: 'a' }, { title: 'b' }] })).toBe(
      'a:A;b:B;',
    );
  });

  it('does not HTML-escape and tolerates missing values', () => {
    expect(render('{{a}}|{{vars.nope}}|{{x.y.z}}', { a: '<b>&"' })).toBe('<b>&"||');
  });
});

describe('partials', () => {
  it('registers built-in partials, overridden by later dirs', () => {
    const one = makeTempDir();
    const two = makeTempDir();
    write(path.join(one, 'greet.hbs'), 'hello from one');
    write(path.join(one, 'nested', 'part.hbs'), 'nested {{a}}');
    write(path.join(two, 'greet.hbs'), 'hello from two');
    const ctx = { a: 1 } as unknown as TemplateContext;
    expect(renderTemplate(createHandlebars({ partialsDirs: [one] }), '{{> greet}}/{{> nested/part}}', ctx, 't')).toBe(
      'hello from one/nested 1',
    );
    expect(renderTemplate(createHandlebars({ partialsDirs: [one, two] }), '{{> greet}}', ctx, 't')).toBe('hello from two');
    expect(Object.keys(createHandlebars().partials)).toContain('flow-context');
    // Missing dirs are ignored.
    expect(() => createHandlebars({ partialsDirs: [path.join(one, 'missing')] })).not.toThrow();
  });
});

describe('buildTemplateContext', () => {
  it('describes the project, the flow, the step and dfl', () => {
    const paths = sampleProject();
    const model = loadFlow(paths, 'sample');
    const ctx = buildTemplateContext(paths, model, { mainBranch: 'main' }, model.byId.get('review'));

    expect(ctx.project).toEqual({ name: path.basename(paths.root), root: paths.root });
    expect(ctx.flow).toMatchObject({ name: 'sample', title: 'Sample flow', initial: 'plan', skillPrefix: '', stepCount: 3 });
    expect(ctx.flow.steps.map((s) => [s.id, s.number, s.index])).toEqual([
      ['plan', 1, 0],
      ['build', 2, 1],
      ['review', 3, 2],
    ]);
    expect(ctx.step).toMatchObject({ id: 'review', skillName: 'review', title: 'Review', number: 3, final: false });
    expect(ctx.step?.next).toEqual([
      { event: 'NEXT', id: 'done', skillName: 'done', title: 'Done', final: true, description: 'All done' },
      {
        event: 'CHANGES_REQUESTED',
        id: 'build',
        skillName: 'build',
        title: 'Build',
        final: false,
        description: 'Reviewer asked for changes',
      },
    ]);
    expect(ctx.step?.prev.map((r) => [r.event, r.id, r.final])).toEqual([['NEXT', 'build', false]]);
    expect(ctx.flow.steps[1]?.prev.map((r) => r.id)).toEqual(['plan', 'review']);
    expect(ctx.vars).toEqual({ mainBranch: 'main' });
    // Only DFL_ENV_* variables reach templates (F28).
    expect(ctx.env['PATH']).toBeUndefined();
    expect(ctx.dfl).toEqual({ version: packageVersion(), mcpServer: 'dfl', cli: 'dfl' });
  });

  it('never exposes the process environment to templates (F28)', () => {
    const paths = sampleProject();
    process.env['DFL_TEST_SECRET'] = 'sentinel-secret';
    process.env['DFL_ENV_TEAM'] = 'core';
    try {
      fs.writeFileSync(
        path.join(paths.stepDir('sample', 'plan'), 'SKILL.md.hbs'),
        '# Plan\n{{json env}} {{env.DFL_TEST_SECRET}} {{#each env}}{{@key}}={{this}};{{/each}} team={{env.TEAM}}\n',
      );
      const [plan] = renderFlowSkills(paths, loadFlow(paths, 'sample'), {});
      const text = skillFile(plan!, 'SKILL.md');
      expect(text).not.toContain('sentinel-secret');
      expect(text).not.toContain(process.env['PATH']!);
      expect(text).toContain('team=core');
      expect(text).toContain('TEAM=core;');
    } finally {
      delete process.env['DFL_TEST_SECRET'];
      delete process.env['DFL_ENV_TEAM'];
    }
  });

  it('uses the skill prefix and handles a missing flow', () => {
    const paths = makeTempProject();
    const def = writeSampleFlow(paths);
    def.skillPrefix = 'x-';
    fs.writeFileSync(paths.flowFile('sample'), JSON.stringify(def));
    const model = loadFlow(paths, 'sample');
    const ctx = buildTemplateContext(paths, model, {}, model.byId.get('plan'));
    expect(ctx.step?.skillName).toBe('x-plan');
    expect(ctx.step?.next[0]?.skillName).toBe('x-build');

    const empty = buildTemplateContext(paths, undefined, {});
    expect(empty.flow).toEqual({ name: '', title: '', description: '', skillPrefix: '', initial: '', steps: [], stepCount: 0 });
    expect(empty.step).toBeUndefined();
  });

  it('uses `npx --no-install dfl` when the project depends on dfl, whichever binary runs (F79, D6)', () => {
    const root = makeTempDir();
    expect(dflCliCommand(root)).toBe('dfl');
    expect(dflCliCommand(root, path.join(root, 'node_modules', '@vishin-pavel', 'dfl'))).toBe('dfl');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
    expect(dflCliCommand(root)).toBe('npx --no-install dfl');
    expect(dflCliCommand(root, path.join(makeTempDir(), 'lib', 'node_modules', '@vishin-pavel', 'dfl'))).toBe('npx --no-install dfl');
  });

  it('renders CLI fallbacks that never resolve `dfl` from the public registry (F79)', () => {
    const paths = sampleProject();
    fs.writeFileSync(path.join(paths.root, 'package.json'), JSON.stringify({ devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
    const model = loadFlow(paths, 'sample');
    const texts = [
      ...renderFlowSkills(paths, model, {}).map((skill) => skillFile(skill, 'SKILL.md')),
      ...renderBuiltinSkills(paths, model, {}).map((skill) => skillFile(skill, 'SKILL.md')),
    ];
    expect(texts.join('\n')).toContain('`npx --no-install dfl status`');
    for (const text of texts) expect(text).not.toMatch(/npx dfl\b/);
  });
});

describe('log helper (F33)', () => {
  it('writes to stderr, never to stdout, and renders nothing', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(render('a{{log "HELLO" 1 obj}}b', { obj: { x: 1 } })).toBe('ab');
      expect(render('{{log 1 level="info"}}')).toBe('');
      expect(stdout).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith('HELLO 1 {"x":1}\n');
      expect(stderr).toHaveBeenCalledWith('1\n');
    } finally {
      stdout.mockRestore();
      info.mockRestore();
      log.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe('renderTemplate errors', () => {
  it('names the file and the line', () => {
    const hb = createHandlebars();
    const ctx = {} as TemplateContext;
    let error: unknown;
    try {
      renderTemplate(hb, 'a\nb\n{{#if x}}\nc\n', ctx, '.df/f/steps/s/SKILL.md.hbs');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DflError);
    expect((error as DflError).message).toMatch(/^Cannot render \.df\/f\/steps\/s\/SKILL\.md\.hbs, line \d+: Parse error/);
    expect(() => renderTemplate(hb, '{{> nope}}', ctx, 'x.hbs')).toThrow(/x\.hbs.*partial nope could not be found/);
    expect(() => renderTemplate(hb, '{{#each a}}\n{{/if}}', ctx, 'y.hbs')).toThrow(/y\.hbs, line 1/);
  });

  it('points at the partial that failed', () => {
    const dir = makeTempDir();
    write(path.join(dir, 'broken.hbs'), '{{#if}}');
    const hb = createHandlebars({ partialsDirs: [dir] });
    expect(() => renderTemplate(hb, 'x {{> broken}}', {} as TemplateContext, 'main.hbs')).toThrow(
      /main\.hbs \(in partial .*broken\.hbs\)/,
    );
  });
});

describe('normalizeSkillMarkdown', () => {
  const meta = { name: 'plan', description: 'Plan  the\n work', metadata: { 'dfl-flow': 'f', 'dfl-step': 'plan' } };

  it('adds frontmatter when there is none', () => {
    expect(normalizeSkillMarkdown('\n\n# Title\n\nBody\n\n\n', meta)).toBe(
      '---\nname: plan\ndescription: Plan the work\nmetadata:\n  dfl-flow: f\n  dfl-step: plan\n---\n\n# Title\n\nBody\n',
    );
  });

  it('forces the name, keeps the description and other keys, merges metadata', () => {
    const input = [
      '---',
      'license: MIT',
      'name: wrong',
      'metadata:',
      '  owner: team',
      '  priority: 2',
      '  dfl-step: stale',
      'description: "Custom: description"',
      'allowed-tools: Read Grep',
      '---',
      '# Body',
    ].join('\n');
    const out = normalizeSkillMarkdown(input, meta);
    const { data, body } = splitSkill(out);
    expect(Object.keys(data)).toEqual(['name', 'description', 'license', 'metadata', 'allowed-tools']);
    expect(data).toEqual({
      name: 'plan',
      description: 'Custom: description',
      license: 'MIT',
      metadata: { owner: 'team', priority: '2', 'dfl-step': 'plan', 'dfl-flow': 'f' },
      'allowed-tools': 'Read Grep',
    });
    expect(body).toBe('# Body\n');
  });

  it('fills an empty description and truncates long ones to 1024 characters', () => {
    const empty = splitSkill(normalizeSkillMarkdown('---\ndescription: ""\n---\nx', { name: 'n', description: 'Fallback' }));
    expect(empty.data).toEqual({ name: 'n', description: 'Fallback' });

    const long = splitSkill(normalizeSkillMarkdown('x', { name: 'n', description: 'word '.repeat(400) }));
    const description = long.data['description'] as string;
    expect(Array.from(description)).toHaveLength(1024);
    expect(description.endsWith('…')).toBe(true);
    expect(description).not.toContain('\n');
  });

  it('accepts an empty frontmatter block', () => {
    expect(normalizeSkillMarkdown('---\n---\nBody', { name: 'n', description: 'd' })).toBe(
      '---\nname: n\ndescription: d\n---\n\nBody\n',
    );
  });

  it('rejects invalid YAML with a DflError naming the source', () => {
    expect(() => normalizeSkillMarkdown('---\nname: [oops\n---\nx', meta, 'steps/plan/SKILL.md.hbs')).toThrow(
      /Invalid YAML frontmatter in steps\/plan\/SKILL\.md\.hbs/,
    );
    expect(() => normalizeSkillMarkdown('---\n- a\n- b\n---\nx', meta)).toThrow(DflError);
    expect(() => normalizeSkillMarkdown('---\nmetadata: text\n---\nx', meta)).toThrow(/metadata/);
  });
});

describe('renderFlowSkills', () => {
  it('renders every non-final step with frontmatter and the flow context', () => {
    const paths = sampleProject();
    const skills = renderFlowSkills(paths, loadFlow(paths, 'sample'), { mainBranch: 'main' });
    expect(skills.map((s) => [s.name, s.kind, s.stepId, s.description])).toEqual([
      ['plan', 'step', 'plan', 'Plan the work'],
      ['build', 'step', 'build', 'Build it'],
      ['review', 'step', 'review', 'Review it'],
    ]);

    for (const skill of skills) {
      const text = skillFile(skill, 'SKILL.md');
      // Written next to the template inside .df.
      expect(fs.readFileSync(path.join(paths.stepDir('sample', skill.stepId!), 'SKILL.md'), 'utf8')).toBe(text);
      const { data } = splitSkill(text);
      expect(data).toEqual({
        name: skill.name,
        description: skill.description,
        metadata: { 'dfl-flow': 'sample', 'dfl-step': skill.stepId },
      });
      const section = flowContextSection(text);
      expect(section.split('\n').length).toBeLessThanOrEqual(25);
      expect(section).toContain('`get_status`');
      expect(section).toContain('`goto_step`');
      expect(section).toContain(`\`{"step": "${skill.stepId}", "event": "<EVENT>", "flow": "sample"}\``);
      expect(section).toContain('`get_status` tool of the `dfl` MCP server with `{"flow": "sample"}`');
      expect(section).toContain('`dfl next <EVENT>');
      expectNoSlashCommandTokens(text);
    }

    const [plan, build, review] = skills.map((s) => flowContextSection(skillFile(s, 'SKILL.md')));
    expect(plan).toContain('step 1 of 3 (**Plan**) of the flow **Sample flow** (`sample`)');
    expect(plan).toContain('- `NEXT` → Build (`/build`): Build it');
    expect(build).toContain('- Comes after: Plan (`/plan`)');
    expect(build).toContain('- Also reached from: Review (`/review`) via `CHANGES_REQUESTED`');
    expect(build).toContain('- `NEXT` → Review (`/review`): Review it\n- `BACK` → Plan (`/plan`): Plan the work');
    expect(review).toContain('step 3 of 3');
    expect(review).toContain('- `NEXT` → flow complete: All done');
    expect(review).toContain('- `CHANGES_REQUESTED` → Build (`/build`): Reviewer asked for changes');
  });

  it('renders extra templates, collects static files and deletes only stale output it rendered (F14, D15)', () => {
    const paths = sampleProject();
    const dir = paths.stepDir('sample', 'plan');
    write(path.join(dir, 'SKILL.md.hbs'), '---\nlicense: MIT\n---\n# {{step.title}} on {{vars.mainBranch}}\n');
    write(path.join(dir, 'refs', 'guide.md.hbs'), 'Guide for {{upper project.name}} ({{flow.name}})');
    write(path.join(dir, 'scripts', 'check.sh'), '#!/bin/sh\necho ok\n');
    write(path.join(dir, 'notes.txt.hbs'), 'not a template');
    write(path.join(dir, 'old', 'stale.md'), 'hand-written, never rendered');
    write(path.join(dir, '.DS_Store'), '');

    const first = renderFlow(paths, loadFlow(paths, 'sample'), { mainBranch: 'trunk' });
    const plan = first.skills[0]!;
    expect(plan.files.map((f) => f.path)).toEqual(['SKILL.md', 'refs/guide.md', 'scripts/check.sh']);
    expect(skillFile(plan, 'SKILL.md')).toBe(
      '---\nname: plan\ndescription: Plan the work\nlicense: MIT\nmetadata:\n  dfl-flow: sample\n  dfl-step: plan\n---\n\n# Plan on trunk\n',
    );
    expect(first.rendered).toEqual([
      '.df/sample/steps/build/SKILL.md',
      '.df/sample/steps/plan/SKILL.md',
      '.df/sample/steps/plan/refs/guide.md',
      '.df/sample/steps/review/SKILL.md',
    ]);
    expect(fs.readFileSync(path.join(dir, 'refs', 'guide.md'), 'utf8')).toBe(`Guide for ${path.basename(paths.root).toUpperCase()} (sample)`);
    // A .md file dfl never rendered is kept (and reported), not deleted.
    expect(first.kept).toEqual(['.df/sample/steps/plan/old/stale.md']);
    expect(first.removed).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'old', 'stale.md'), 'utf8')).toBe('hand-written, never rendered');

    // Removing a template removes its rendered output on the next render (dfl rendered it before).
    fs.rmSync(path.join(dir, 'refs', 'guide.md.hbs'));
    const again = renderFlow(paths, loadFlow(paths, 'sample'), { mainBranch: 'trunk' }, { previouslyRendered: first.rendered });
    expect(again.skills[0]!.files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/check.sh']);
    expect(again.removed).toEqual(['.df/sample/steps/plan/refs/guide.md']);
    expect(fs.existsSync(path.join(dir, 'refs'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'old', 'stale.md'))).toBe(true);
  });

  it('includes extra rendered .md files in the skill', () => {
    const paths = sampleProject();
    write(path.join(paths.stepDir('sample', 'plan'), 'refs', 'guide.md.hbs'), 'Guide ({{flow.name}})');
    const [plan] = renderFlowSkills(paths, loadFlow(paths, 'sample'), {});
    expect(plan!.files.map((f) => f.path)).toEqual(['SKILL.md', 'refs/guide.md']);
    expect(skillFile(plan!, 'refs/guide.md')).toBe('Guide (sample)');
  });

  it('keeps a hand-written reference .md file by default (manifest without a record)', () => {
    const paths = sampleProject();
    const file = path.join(paths.stepDir('sample', 'plan'), 'references', 'checklist.md');
    write(file, '# checklist');
    const result = renderFlow(paths, loadFlow(paths, 'sample'), {});
    expect(fs.readFileSync(file, 'utf8')).toBe('# checklist');
    expect(result.kept).toEqual(['.df/sample/steps/plan/references/checklist.md']);
    expect(result.skills[0]!.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('reads the previous render record from .df/installed.json', () => {
    const paths = sampleProject();
    write(
      paths.manifestFile,
      JSON.stringify({ version: 1, rendered: ['.df/sample/steps/plan/old.md', '../outside.md', '.df/sample/steps/x/../../y.md', 42] }),
    );
    expect([...readRenderedOutputs(paths)]).toEqual(['.df/sample/steps/plan/old.md']);
    write(path.join(paths.stepDir('sample', 'plan'), 'old.md'), 'rendered earlier');
    const result = renderFlow(paths, loadFlow(paths, 'sample'), {});
    expect(result.removed).toEqual(['.df/sample/steps/plan/old.md']);
    expect(isRenderedOutputPath('.df/sample/steps/plan/SKILL.md')).toBe(true);
    expect(isRenderedOutputPath('.df/sample/steps/plan/SKILL.md.hbs')).toBe(false);
    expect(isRenderedOutputPath('.df/Bad/steps/plan/SKILL.md')).toBe(false);
    expect(isRenderedOutputPath('.df/sample/partials/x.md')).toBe(false);
  });

  it('removes orphan step dirs that only hold dfl-rendered files (C2)', () => {
    const paths = sampleProject();
    const first = renderFlow(paths, loadFlow(paths, 'sample'), {});
    // Upstream rename of "build": git moved the template, the ignored rendered SKILL.md stayed.
    const def = JSON.parse(fs.readFileSync(paths.flowFile('sample'), 'utf8')) as Record<string, any>;
    const states = def['machine'].states;
    states['make'] = { ...states['build'] };
    delete states['build'];
    states['plan'].on = { NEXT: 'make' };
    states['review'].on = { NEXT: 'done', CHANGES_REQUESTED: 'make' };
    fs.writeFileSync(paths.flowFile('sample'), JSON.stringify(def));
    fs.mkdirSync(paths.stepDir('sample', 'make'));
    fs.renameSync(path.join(paths.stepDir('sample', 'build'), 'SKILL.md.hbs'), path.join(paths.stepDir('sample', 'make'), 'SKILL.md.hbs'));
    // An orphan that also holds a hand-written file is kept.
    write(path.join(paths.stepsDir('sample'), 'mine', 'notes.md'), 'mine');

    const result = renderFlow(paths, loadFlow(paths, 'sample'), {}, { previouslyRendered: first.rendered });
    expect(result.removed).toEqual(['.df/sample/steps/build']);
    expect(fs.existsSync(paths.stepDir('sample', 'build'))).toBe(false);
    expect(fs.readFileSync(path.join(paths.stepsDir('sample'), 'mine', 'notes.md'), 'utf8')).toBe('mine');
  });

  it.skipIf(process.platform === 'win32')('never deletes stale output through a symlinked step dir', () => {
    const paths = sampleProject();
    const outside = makeTempDir();
    write(path.join(outside, 'SKILL.md.hbs'), '# Outside');
    write(path.join(outside, 'victim.md'), 'keep me');
    fs.rmSync(paths.stepDir('sample', 'build'), { recursive: true });
    fs.symlinkSync(outside, paths.stepDir('sample', 'build'));
    expect(firstSymlinkBetween(paths.root, path.join(paths.stepDir('sample', 'build'), 'x'))).toBe(paths.stepDir('sample', 'build'));
    const result = renderFlow(paths, loadFlow(paths, 'sample'), {}, { previouslyRendered: ['.df/sample/steps/build/victim.md'] });
    expect(result.removed).toEqual([]);
    expect(fs.readFileSync(path.join(outside, 'victim.md'), 'utf8')).toBe('keep me');
  });

  it('uses the default template when SKILL.md.hbs is missing and flow partial overrides', () => {
    const paths = sampleProject();
    fs.rmSync(path.join(paths.stepDir('sample', 'build'), 'SKILL.md.hbs'));
    write(path.join(paths.partialsDir('sample'), 'flow-context.hbs'), '## Custom context for {{step.id}}\n');
    const skills = renderFlowSkills(paths, loadFlow(paths, 'sample'), {});
    const build = skillFile(skills[1]!, 'SKILL.md');
    expect(build).toContain('# Build\n\nBuild it\n');
    expect(build).toContain('## Custom context for build');
    expect(build).not.toContain('get_status');
    expect(fs.existsSync(path.join(paths.stepDir('sample', 'build'), 'SKILL.md'))).toBe(true);
  });

  it('renders the default template without a blank gap when the step has no description', () => {
    const paths = makeTempProject();
    const def = writeSampleFlow(paths);
    delete def.machine.states['build']!.description;
    fs.writeFileSync(paths.flowFile('sample'), JSON.stringify(def));
    const skills = renderFlowSkills(paths, loadFlow(paths, 'sample'), {});
    const { body } = splitSkill(skillFile(skills.find((s) => s.name === 'build')!, 'SKILL.md'));
    expect(body).toMatch(/^# Build\n\n## Instructions\n/);
    const plan = splitSkill(skillFile(skills.find((s) => s.name === 'plan')!, 'SKILL.md'));
    expect(plan.body).toMatch(/^# Plan\n\nPlan the work\n\n## Instructions\n/);
  });

  it('reports template errors with the project-relative file name', () => {
    const paths = sampleProject();
    write(path.join(paths.stepDir('sample', 'review'), 'SKILL.md.hbs'), '# ok\n{{#each}}\n');
    expect(() => renderFlowSkills(paths, loadFlow(paths, 'sample'), {})).toThrow(
      /Cannot render \.df\/sample\/steps\/review\/SKILL\.md\.hbs, line \d+/,
    );
  });

  it('renders a step with no outgoing transitions', () => {
    const paths = makeTempProject();
    const def = writeSampleFlow(paths);
    def.machine.states['review'] = { description: 'Review it', meta: { title: 'Review' } };
    fs.writeFileSync(paths.flowFile('sample'), JSON.stringify(def));
    const skills = renderFlowSkills(paths, loadFlow(paths, 'sample'), {});
    const review = flowContextSection(skillFile(skills.find((s) => s.name === 'review')!, 'SKILL.md'));
    expect(review).toContain('no outgoing events');
    expect(review).not.toContain('complete_step');
    expect(review).toContain('pass `"task": "<task.key>"` to `goto_step` (CLI: `--task <key>`).');
  });

  it('tells the agent to pass a ticket the user named on to get_status and the moves (flows tracked in Jira)', () => {
    const paths = sampleProject();
    for (const skill of renderFlowSkills(paths, loadFlow(paths, 'sample'), {})) {
      const section = flowContextSection(skillFile(skill, 'SKILL.md'));
      const paragraph =
        'If the user named a ticket after the command, pass the ticket key (e.g. `ABC-123`) as `"task"` to `get_status`. ' +
        'If the result has a `task`, follow `task.instructions` and pass `"task": "<task.key>"` to `complete_step` / `goto_step` ' +
        '(CLI: `--task <key>`).';
      expect(section).toContain(`\n\n${paragraph}\n\n`);
      // Between "Before you start" and "When done".
      expect(section.indexOf(paragraph)).toBeGreaterThan(section.indexOf('**Before you start:**'));
      expect(section.indexOf(paragraph)).toBeLessThan(section.indexOf('**When done:**'));
      expect(section.split('\n').length).toBeLessThanOrEqual(25);
    }
  });
});

describe('renderBuiltinSkills', () => {
  function fixtureSkills(): string {
    const dir = makeTempDir('dfl-builtins-');
    write(
      path.join(dir, 'add-flow-step', 'SKILL.md.hbs'),
      [
        '---',
        'name: add-flow-step',
        'description: Add a step to the {{default flow.name "active"}} flow.',
        '---',
        '# Add a step',
        '{{#if step}}STEP{{/if}}',
        '{{> flow-context}}',
        '',
      ].join('\n'),
    );
    write(path.join(dir, 'add-flow-step', 'reference', 'schema.md.hbs'), 'Flow {{flow.title}}');
    write(path.join(dir, 'add-flow-step', 'reference', 'schema.md'), 'stale output, ignored');
    write(path.join(dir, 'add-flow-step', 'example.json'), '{}');
    write(path.join(dir, 'not-a-skill', 'README.md'), 'no template');
    return dir;
  }

  it('renders fixture built-ins in memory with the active flow context', () => {
    const paths = sampleProject();
    const dir = fixtureSkills();
    expect(builtinSkillNames(dir)).toEqual(['add-flow-step']);

    const [skill, ...rest] = renderBuiltinSkills(paths, loadFlow(paths, 'sample'), {}, { dir });
    expect(rest).toEqual([]);
    expect(skill).toMatchObject({ name: 'add-flow-step', kind: 'builtin', description: 'Add a step to the sample flow.' });
    expect(skill!.stepId).toBeUndefined();
    expect(skill!.files.map((f) => f.path)).toEqual(['SKILL.md', 'example.json', 'reference/schema.md']);
    expect(skill!.files[1]!.sourcePath).toBe(path.join(dir, 'add-flow-step', 'example.json'));
    expect(skillFile(skill!, 'reference/schema.md')).toBe('Flow Sample flow');

    const text = skillFile(skill!, 'SKILL.md');
    const { data, body } = splitSkill(text);
    expect(data).toEqual({
      name: 'add-flow-step',
      description: 'Add a step to the sample flow.',
      metadata: { 'dfl-builtin': 'true' },
    });
    expect(body).not.toContain('STEP');
    expect(body).toContain('Active flow: **Sample flow** (`sample`) with 3 steps: Plan (`/plan`), Build (`/build`), Review (`/review`).');
    expectNoSlashCommandTokens(text);
    // Nothing is written next to the built-in templates.
    expect(fs.readFileSync(path.join(dir, 'add-flow-step', 'reference', 'schema.md'), 'utf8')).toBe('stale output, ignored');
  });

  it('works without a flow', () => {
    const paths = makeTempProject();
    const [skill] = renderBuiltinSkills(paths, undefined, {}, { dir: fixtureSkills() });
    expect(skill!.description).toBe('Add a step to the active flow.');
    expect(skillFile(skill!, 'SKILL.md')).toContain('This project has no active flow yet.');
  });

  it('lists the packaged built-in skills', () => {
    expect(Array.isArray(builtinSkillNames())).toBe(true);
  });

  it('renders the packaged init-task skill only when the project has .df/tracker.json', () => {
    const paths = sampleProject();
    const model = loadFlow(paths, 'sample');
    expect(builtinSkillNames()).toContain('init-task');
    expect(builtinSkillEnabled(paths, 'init-task')).toBe(false);
    expect(builtinSkillEnabled(paths, 'add-flow-step')).toBe(true);
    expect(renderBuiltinSkills(paths, model, {}).map((skill) => skill.name)).not.toContain('init-task');

    // Existence is enough (the file is parsed only by the tracker commands and tools).
    write(paths.trackerFile, '{}\n');
    expect(builtinSkillEnabled(paths, 'init-task')).toBe(true);
    const init = renderBuiltinSkills(paths, model, {}).find((skill) => skill.name === 'init-task');
    expect(init).toMatchObject({ kind: 'builtin', description: expect.stringMatching(/^Start or continue work on a Jira ticket: /) });
    const text = skillFile(init!, 'SKILL.md');
    expect(splitSkill(text).data).toEqual({ name: 'init-task', description: init!.description, metadata: { 'dfl-builtin': 'true' } });
    expect(text).toContain('`start_task` tool of the `dfl` MCP server');
    expect(text).toContain('`dfl task start "<ticket>"`');
    expect(text).toContain('Active flow at the last sync: **Sample flow** (`sample`).');
    expect(text).not.toContain('## Flow context');
    expect(slashCommandTokens(text)).toEqual([]);
    expectNoSlashCommandTokens(text);

    // A fixture dir without init-task is not affected.
    const dir = makeTempDir('dfl-builtins-');
    write(path.join(dir, 'other', 'SKILL.md.hbs'), '# Other\n');
    expect(renderBuiltinSkills(paths, model, {}, { dir }).map((skill) => skill.name)).toEqual(['other']);
  });
});

describe('slash-command tokens in rendered skills (G8, F76)', () => {
  it('finds the tokens agents expand, outside frontmatter and (for @word) outside code fences', () => {
    expect(slashCommandTokens('---\nname: x\ndescription: mail @me\n---\nplain text, a@b.c')).toEqual([]);
    expect(slashCommandTokens('Use $ARGUMENTS and $1\n!`ls`\nask @octocat')).toEqual([
      '$ARGUMENTS',
      '$<digit>',
      'a line starting with !`',
      '@word',
    ]);
    expect(slashCommandTokens('```java\n@Override\n```\n')).toEqual([]);
  });

  it('warns when a variable value puts one into a rendered SKILL.md', () => {
    const paths = sampleProject();
    write(path.join(paths.stepDir('sample', 'review'), 'SKILL.md.hbs'), '# Review\n\nAsk {{vars.reviewer}} for a review.\n');
    const model = loadFlow(paths, 'sample');
    const clean = renderFlow(paths, model, { reviewer: 'octocat' });
    expect(clean.warnings).toEqual([]);
    const result = renderFlow(paths, model, { reviewer: '@octocat' });
    expect(result.warnings).toEqual([
      expect.stringMatching(/^\.df\/sample\/steps\/review\/SKILL\.md contains @word: Claude Code and OpenCode expand/),
    ]);
  });
});
