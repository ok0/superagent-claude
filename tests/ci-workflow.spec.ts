import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRETS_CONTEXT = /\$\{\{(?:(?!\}\})[^\n])*?(?<![\w.-])secrets\b/;
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

const JOB_NAMES = ['check', 'image'] as const;

function block(text: string, header: RegExp): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    out.push(line);
  }
  return out;
}

function jobSection(text: string, name: string): string | undefined {
  const headers = JOB_NAMES.map((job) => ({ job, index: text.search(new RegExp(`^  ${job}:\\s*$`, 'm')) }))
    .filter((entry) => entry.index !== -1)
    .sort((a, b) => a.index - b.index);
  const current = headers.findIndex((entry) => entry.job === name);
  if (current === -1) return undefined;
  const start = headers[current]!.index;
  const end = headers[current + 1]?.index ?? text.length;
  return text.slice(start, end);
}

export function workflowProblems(text: string): string[] {
  const problems: string[] = [];

  const triggerBlock = block(text, /^on:\s*$/);
  const triggerKeys = new Set(
    triggerBlock.map((line) => /^  ([a-z_]+):/.exec(line)?.[1]).filter((key): key is string => key !== undefined),
  );
  const expectedTriggers = new Set(['push', 'pull_request']);
  const sameTriggers =
    triggerKeys.size === expectedTriggers.size && [...expectedTriggers].every((key) => triggerKeys.has(key));
  if (!sameTriggers) problems.push(`triggers must be exactly push and pull_request, found: ${[...triggerKeys].join(', ')}`);
  if (text.includes('pull_request_target')) problems.push('pull_request_target trigger is forbidden');

  const permissionHits = text.match(/^\s*permissions:/gm) ?? [];
  if (permissionHits.length !== 1) {
    problems.push(`expected exactly 1 permissions block, found ${permissionHits.length}`);
  } else if (!/^permissions:/m.test(text)) {
    problems.push('permissions block must be at column 0');
  } else {
    const permissionLines = block(text, /^permissions:/).filter((line) => line.trim() !== '');
    if (JSON.stringify(permissionLines) !== JSON.stringify(['  contents: read'])) {
      problems.push('permissions must be exactly contents: read');
    }
  }

  for (const job of JOB_NAMES) {
    if (!new RegExp(`^  ${job}:\\s*$`, 'm').test(text)) problems.push(`missing job: ${job}`);
  }

  const checkSection = jobSection(text, 'check');
  if (checkSection !== undefined) {
    const required: Array<[string, boolean]> = [
      ['pnpm install --frozen-lockfile', checkSection.includes('pnpm install --frozen-lockfile')],
      ['fetch-depth: 0', checkSection.includes('fetch-depth: 0')],
      ['- run: pnpm typecheck', /^\s+- run: pnpm typecheck$/m.test(checkSection)],
      ['- run: pnpm test', /^\s+- run: pnpm test$/m.test(checkSection)],
      ['- run: pnpm build', /^\s+- run: pnpm build$/m.test(checkSection)],
      ['- run: pnpm check:branding', /^\s+- run: pnpm check:branding$/m.test(checkSection)],
      ['- run: pnpm check:commits', /^\s+- run: pnpm check:commits$/m.test(checkSection)],
    ];
    for (const [label, ok] of required) {
      if (!ok) problems.push(`check job missing: ${label}`);
    }
    if (checkSection.includes('docker')) problems.push('check job must not use docker');
  }

  const imageSection = jobSection(text, 'image');
  if (imageSection !== undefined) {
    if (!/^\s+- run: docker build -t superagent-claude:ci \.$/m.test(imageSection)) {
      problems.push('image job missing: docker build -t superagent-claude:ci .');
    }
  }

  if (SECRETS_CONTEXT.test(text)) problems.push('forbidden: ${{ secrets }} reference');
  const forbidden = ['test:live', 'SUPERAGENT_CLAUDE_LIVE', 'docker push', 'push: true', 'docker login'];
  for (const word of forbidden) {
    if (text.includes(word)) problems.push(`forbidden: ${word}`);
  }
  for (const token of text.match(/\b[A-Z0-9_]*TOKEN[A-Z0-9_]*\b/g) ?? []) {
    if (token !== 'GITHUB_TOKEN') problems.push(`forbidden token name: ${token}`);
  }

  for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    const target = match[1] ?? '';
    if (!/^actions\/[a-z0-9-]+@v\d+$/.test(target)) problems.push(`action not allowed: ${target}`);
  }

  return problems;
}

describe('ci workflow', () => {
  const real = read('.github/workflows/ci.yml');

  it('the real workflow has no problems', () => {
    expect(workflowProblems(real)).toEqual([]);
  });

  it('flags only ${{ secrets }} references, not file names', () => {
    const script = real + '      - run: bash scripts/check-image-secrets.sh superagent-claude:ci\n';
    expect(workflowProblems(script).filter((p) => p.includes('secrets'))).toEqual([]);
    const secret = real + '      - run: echo ${{ secrets.X }}\n';
    expect(workflowProblems(secret).filter((p) => p.includes('secrets'))).toHaveLength(1);
  });

  it.each<[string, (text: string) => string]>([
    ['secrets reference', (t) => t + '      - run: echo ${{ secrets.X }}\n'],
    ['live test run', (t) => t.replace('run: pnpm test\n', 'run: pnpm test:live\n')],
    ['docker push', (t) => t + '      - run: docker push superagent-claude:ci\n'],
    ['non-actions action', (t) => t.replace('actions/checkout@v5', 'pnpm/action-setup@v4')],
    ['pull_request_target trigger', (t) => t.replace('  pull_request:\n', '  pull_request_target:\n')],
    ['extra permission', (t) => t.replace('  contents: read\n', '  contents: read\n  pull-requests: write\n')],
    ['missing fetch-depth', (t) => t.replace('          fetch-depth: 0\n', '')],
    ['missing image job', (t) => t.slice(0, t.indexOf('\n  image:'))],
    ['live env flag', (t) => t + '      - run: SUPERAGENT_CLAUDE_LIVE=1 pnpm test\n'],
    ['non-GitHub token', (t) => t + '    env:\n      NPM_TOKEN: x\n'],
    ['push true', (t) => t + '          push: true\n'],
    ['docker login', (t) => t + '      - run: docker login ghcr.io\n'],
  ])('detects a violation: %s', (_label, mutate) => {
    expect(workflowProblems(mutate(real)).length).toBeGreaterThan(0);
  });

  it('check:all chains the CI checks', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:all']).toBe('pnpm check && pnpm check:branding && pnpm check:commits');
    expect(pkg.scripts.check).toBe('pnpm typecheck && pnpm test && pnpm build');
  });
});
