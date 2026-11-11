import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const JOBS = ['verify', 'npm', 'image', 'release'] as const;

export const EXPECTED_PERMISSIONS: Record<(typeof JOBS)[number], string[]> = {
  verify: ['actions: read', 'contents: read'],
  npm: ['contents: read', 'id-token: write'],
  image: ['contents: read', 'packages: write'],
  release: ['contents: write'],
};

export const EXPECTED_NEEDS: Record<(typeof JOBS)[number], string[]> = {
  verify: [],
  npm: ['verify'],
  image: ['verify', 'npm'],
  release: ['verify', 'npm', 'image'],
};

export const ALLOWED_TOKEN_NAMES = ['GITHUB_TOKEN', 'GH_TOKEN'];

export const MIN_NPM = [11, 5, 1] as const;

const OIDC_RUN = 'npm publish --provenance --tag "$DIST_TAG" --access public';
const DOCKER_BUILD_LINE =
  'docker build --label org.opencontainers.image.source=https://github.com/ok0/superagent-claude --label "org.opencontainers.image.version=$VERSION"';
const VERIFY_LITERALS = [
  'fetch-depth: 0',
  'pnpm install --frozen-lockfile',
  'node scripts/release.ts verify-tag "$GITHUB_REF_NAME"',
  'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
  'node scripts/release.ts ci-gate "$GITHUB_SHA"',
  'GH_TOKEN: ${{ github.token }}',
  'pnpm check:all',
  'node scripts/release.ts pack-check',
  'node scripts/changelog.ts notes "$VERSION"',
  "grep -q '[^[:space:]]'",
  DOCKER_BUILD_LINE,
  'node scripts/release.ts outputs "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"',
  'check-image-secrets.sh',
];
const VERIFY_OUTPUTS = [
  'dist_tag: ${{ steps.meta.outputs.dist_tag }}',
  'image_tags: ${{ steps.meta.outputs.image_tags }}',
  'prerelease: ${{ steps.meta.outputs.prerelease }}',
  'version: ${{ steps.meta.outputs.version }}',
];
export const SECRETS_CONTEXT = /\$\{\{(?:(?!\}\})[^\n])*?(?<![\w.-])secrets\b/;
const PUBLISH_WORDS:Array<[string, (typeof JOBS)[number]]> = [
  ['npm publish', 'npm'],
  ['docker push', 'image'],
  ['docker login', 'image'],
  ['gh release create', 'release'],
];

function topBlock(text: string, key: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    out.push(line);
  }
  return out;
}

function jobHeaders(text: string): { name: string; index: number }[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];
  const out: { name: string; index: number }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[i] ?? '');
    if (match) out.push({ name: match[1]!, index: i });
  }
  return out;
}

function jobText(text: string, name: string): string | undefined {
  const lines = text.split('\n');
  const headers = jobHeaders(text);
  const current = headers.findIndex((header) => header.name === name);
  if (current === -1) return undefined;
  const start = headers[current]!.index;
  const end = headers[current + 1]?.index ?? lines.length;
  return lines.slice(start, end).join('\n');
}

function jobHead(job: string): string {
  const lines = job.split('\n');
  const stepsLine = lines.findIndex((line) => /^    steps:\s*$/.test(line));
  return (stepsLine === -1 ? lines : lines.slice(0, stepsLine)).join('\n');
}

function steps(job: string): string[] {
  const lines = job.split('\n');
  const start = lines.findIndex((line) => /^    steps:\s*$/.test(line));
  if (start === -1) return [];
  const chunks: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^      - /.test(line)) chunks.push([line]);
    else if (chunks.length > 0) chunks[chunks.length - 1]!.push(line);
  }
  return chunks.map((chunk) => chunk.join('\n'));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stepIndex(job: string, name: string): number {
  const header = new RegExp(`^\\s*-?\\s*name: ${escapeRegExp(name)}\\s*$`, 'm');
  return steps(job).findIndex((step) => header.test(step));
}

function stepNamed(job: string, name: string): string | undefined {
  const index = stepIndex(job, name);
  return index === -1 ? undefined : steps(job)[index];
}

function mapLines(job: string, key: string): string[] {
  const lines = job.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^    ${key}:\\s*$`).test(line));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (!/^ {6,}/.test(line)) break;
    out.push(line.trim());
  }
  return out;
}

function needsOf(job: string): string[] {
  const match = /^    needs:\s*\[([^\]]*)\]\s*$/m.exec(job);
  if (!match) return [];
  return (match[1] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function sameList(actual: string[], expected: readonly string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function releaseWorkflowProblems(text: string): string[] {
  const problems: string[] = [];

  const onBlock = topBlock(text, 'on');
  const triggerKeys = onBlock
    .map((line) => /^  ([a-z_]+):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
  if (JSON.stringify(triggerKeys) !== JSON.stringify(['push'])) {
    problems.push(`triggers: expected only push, found ${triggerKeys.join(', ') || 'none'}`);
  }
  const pushIndex = onBlock.findIndex((line) => /^  push:\s*$/.test(line));
  const pushLines: string[] = [];
  for (const line of pushIndex === -1 ? [] : onBlock.slice(pushIndex + 1)) {
    if (/^  \S/.test(line)) break;
    if (line.trim() !== '') pushLines.push(line.trim());
  }
  if (JSON.stringify(pushLines) !== JSON.stringify(["tags: ['v*']"])) {
    problems.push(`push filter: expected only tags: ['v*'], found ${pushLines.join(' | ') || 'none'}`);
  }
  for (const word of ['pull_request', 'workflow_dispatch', 'schedule:', 'workflow_run', 'branches']) {
    if (text.includes(word)) problems.push(`forbidden trigger: ${word}`);
  }

  const topPermissionLines = text.match(/^permissions:/gm) ?? [];
  if (!/^permissions: \{\}\s*$/m.test(text) || topPermissionLines.length !== 1) {
    problems.push('top permissions must be exactly one column-0 "permissions: {}"');
  }
  const concurrency = topBlock(text, 'concurrency')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (JSON.stringify(concurrency) !== JSON.stringify(['group: release-${{ github.ref }}', 'cancel-in-progress: false'])) {
    problems.push(`concurrency: unexpected block ${concurrency.join(' | ')}`);
  }

  const names = jobHeaders(text).map((header) => header.name);
  if (JSON.stringify(names) !== JSON.stringify(JOBS)) {
    problems.push(`jobs: expected ${JOBS.join(', ')}, found ${names.join(', ')}`);
  }

  for (const job of JOBS) {
    const body = jobText(text, job) ?? '';
    const permissions = mapLines(body, 'permissions').sort();
    if (JSON.stringify(permissions) !== JSON.stringify([...EXPECTED_PERMISSIONS[job]].sort())) {
      problems.push(`permissions ${job}: found ${permissions.join(', ') || 'none'}`);
    }
    const needs = needsOf(body);
    if (JSON.stringify(needs) !== JSON.stringify(EXPECTED_NEEDS[job])) {
      problems.push(`needs ${job}: found ${needs.join(', ') || 'none'}`);
    }
  }
  for (const line of text.split('\n')) {
    const match = /^(\s*)permissions:/.exec(line);
    if (match && match[1]!.length !== 0 && match[1]!.length !== 4) {
      problems.push('permissions at unexpected indent');
    }
  }

  for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    const target = match[1] ?? '';
    if (!/^actions\/(checkout|setup-node)@v5$/.test(target)) problems.push(`action not allowed: ${target}`);
  }
  if (count(text, 'uses: actions/checkout@v5') !== count(text, 'persist-credentials: false')) {
    problems.push('checkout without persist-credentials: false');
  }

  const verify = jobText(text, 'verify') ?? '';
  for (const literal of VERIFY_LITERALS) {
    if (!verify.includes(literal)) problems.push(`verify missing: ${literal}`);
  }
  if (!sameList(mapLines(verify, 'outputs'), VERIFY_OUTPUTS)) {
    problems.push(`verify outputs: found ${mapLines(verify, 'outputs').join(', ')}`);
  }
  for (const word of ['npm publish', 'docker push', 'docker login', 'gh release create']) {
    if (verify.includes(word)) problems.push(`verify publishes: ${word}`);
  }
  if (SECRETS_CONTEXT.test(verify)) problems.push('verify publishes: secrets.');

  for (const [word, owner] of PUBLISH_WORDS) {
    for (const job of JOBS) {
      if (job === owner) continue;
      if ((jobText(text, job) ?? '').includes(word)) problems.push(`${word} outside ${job}`);
    }
  }

  const npm = jobText(text, 'npm') ?? '';
  if (text.includes('registry-url')) problems.push('registry-url forbidden');
  const pin = /npm install --global npm@(\d+)\.(\d+)\.(\d+)/.exec(npm);
  if (!pin) {
    problems.push('npm version pin missing');
  } else {
    const triple = [Number(pin[1]), Number(pin[2]), Number(pin[3])];
    const isLess = (() => {
      for (let i = 0; i < MIN_NPM.length; i++) {
        const value = triple[i] ?? 0;
        if (value !== MIN_NPM[i]) return value < MIN_NPM[i]!;
      }
      return false;
    })();
    if (isLess) problems.push(`npm version pin below ${MIN_NPM.join('.')}: ${pin[0]}`);
  }
  for (const name of ['publish (oidc)', 'check published', 'verify dist-tag']) {
    if (stepNamed(npm, name) === undefined) problems.push(`npm missing step: ${name}`);
  }

  const publishSteps = steps(npm).filter((step) => step.includes('npm publish') || /^\s*-?\s*name: publish\b/m.test(step));
  if (publishSteps.length !== 1 || stepIndex(npm, 'publish (oidc)') === -1) {
    problems.push('exactly one publish step, named publish (oidc), is allowed');
  }

  const oidc = stepNamed(npm, 'publish (oidc)') ?? '';
  const oidcIf = /^\s*if:\s*(.*)$/m.exec(oidc)?.[1] ?? '';
  if (oidcIf.trim() !== "steps.published.outputs.exists == 'false'") {
    problems.push('oidc step must run only when the version is not published');
  }
  if (!oidc.includes(OIDC_RUN)) problems.push('oidc step must publish with provenance');
  if (
    /[A-Z0-9_]*TOKEN[A-Z0-9_]*/.test(oidc) ||
    SECRETS_CONTEXT.test(oidc) ||
    oidc.includes('.npmrc') ||
    oidc.includes('NPM_CONFIG_USERCONFIG') ||
    oidc.includes('env:')
  ) {
    problems.push('oidc step must not use tokens, secrets, .npmrc or env');
  }

  const dist = stepNamed(npm, 'verify dist-tag') ?? '';
  const distIndex = stepIndex(npm, 'verify dist-tag');
  const publishIndexes = [stepIndex(npm, 'publish (oidc)')];
  if (
    /^\s*if:/m.test(dist) ||
    publishIndexes.some((index) => index === -1 || index >= distIndex) ||
    !dist.includes('npm view superagent-claude "dist-tags.$DIST_TAG"') ||
    !dist.includes('exit 1')
  ) {
    problems.push('dist-tag check must be an unconditional final step that fails on mismatch');
  }

  const published = stepNamed(npm, 'check published') ?? '';
  if (!published.includes('npm view "superagent-claude@$VERSION" version')) {
    problems.push('publish skip check missing');
  }
  const secretLines = text.split('\n').filter((line) => SECRETS_CONTEXT.test(line));
  for (const line of secretLines) problems.push(`secrets reference not allowed: ${line.trim()}`);
  for (const word of ['bootstrap', 'NPM_TOKEN', '.npmrc', 'NPM_CONFIG_USERCONFIG', 'NODE_AUTH_TOKEN']) {
    if (text.toLowerCase().includes(word.toLowerCase())) problems.push(`forbidden in release workflow: ${word}`);
  }
  for (const match of text.matchAll(/\b[A-Z0-9_]*TOKEN[A-Z0-9_]*\b/g)) {
    if (!ALLOWED_TOKEN_NAMES.includes(match[0])) problems.push(`token name not allowed: ${match[0]}`);
  }

  const image = jobText(text, 'image') ?? '';
  const imageLiterals = [
    'GITHUB_TOKEN: ${{ github.token }}',
    'docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin',
    'echo "$GITHUB_TOKEN" |',
    'docker push "ghcr.io/ok0/superagent-claude:$tag"',
    DOCKER_BUILD_LINE,
  ];
  for (const literal of imageLiterals) {
    if (!image.includes(literal)) problems.push(`image missing: ${literal}`);
  }
  for (const match of text.matchAll(/ghcr\.io\/[A-Za-z0-9._/-]+/g)) {
    if (match[0] !== 'ghcr.io/ok0/superagent-claude') problems.push(`registry target not allowed: ${match[0]}`);
  }
  for (const word of ['docker.io', 'quay.io', '--platform', 'buildx']) {
    if (text.includes(word)) problems.push(`image forbidden: ${word}`);
  }

  const release = jobText(text, 'release') ?? '';
  const releaseLiterals = [
    'gh release view "$GITHUB_REF_NAME"',
    '--verify-tag',
    '--notes-file',
    '--prerelease',
    '--latest',
    'if [ "$PRERELEASE" = "true" ]',
    'node scripts/changelog.ts notes "$VERSION"',
    'GH_TOKEN: ${{ github.token }}',
  ];
  for (const literal of releaseLiterals) {
    if (!release.includes(literal)) problems.push(`release missing: ${literal}`);
  }

  if (/\bM\d+\b/.test(text)) problems.push('wording: milestone identifier found');
  if (/milestone/i.test(text)) problems.push('wording: the word milestone found');

  return problems;
}

const real = readFileSync(`${ROOT}.github/workflows/release.yml`, 'utf8');

function replaceFirst(text: string, from: string, to: string): string {
  return text.replace(from, () => to);
}

function replaceAllOf(text: string, from: string, to: string): string {
  return text.replaceAll(from, () => to);
}

const MUTATIONS: Array<{ name: string; mutate: (text: string) => string }> = [
  { name: 'pull_request trigger', mutate: (t) => replaceFirst(t, 'on:\n  push:\n', 'on:\n  pull_request:\n  push:\n') },
  { name: 'workflow_dispatch trigger', mutate: (t) => replaceFirst(t, 'on:\n  push:\n', 'on:\n  workflow_dispatch:\n  push:\n') },
  { name: 'branches filter', mutate: (t) => replaceFirst(t, "    tags: ['v*']\n", "    branches: [main]\n    tags: ['v*']\n") },
  { name: 'npm without verify', mutate: (t) => replaceFirst(t, 'needs: [verify]\n', 'needs: []\n') },
  { name: 'image without verify', mutate: (t) => replaceFirst(t, 'needs: [verify, npm]\n', 'needs: [npm]\n') },
  { name: 'release without verify', mutate: (t) => replaceFirst(t, 'needs: [verify, npm, image]\n', 'needs: [npm, image]\n') },
  { name: 'secrets in verify', mutate: (t) => replaceFirst(t, 'GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.X }}') },
  { name: 'secrets in image', mutate: (t) => replaceFirst(t, 'GITHUB_TOKEN: ${{ github.token }}', 'GITHUB_TOKEN: ${{ secrets.X }}') },
  { name: 'secrets in release', mutate: (t) => `${t}      - run: echo \${{ secrets.X }}\n` },
  {
    name: 'token env on oidc step',
    mutate: (t) =>
      replaceFirst(t, '      - name: publish (oidc)\n', '      - name: publish (oidc)\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'),
  },
  {
    name: 'placeholder token on oidc step',
    mutate: (t) => replaceFirst(t, '      - name: publish (oidc)\n', '      - name: publish (oidc)\n        env:\n          NODE_AUTH_TOKEN: x\n'),
  },
  { name: 'id-token in image', mutate: (t) => replaceFirst(t, '      packages: write\n', '      packages: write\n      id-token: write\n') },
  { name: 'id-token in verify', mutate: (t) => replaceFirst(t, '      actions: read\n', '      actions: read\n      id-token: write\n') },
  { name: 'packages in release', mutate: (t) => replaceFirst(t, '      contents: write\n', '      contents: write\n      packages: write\n') },
  { name: 'contents write in npm', mutate: (t) => replaceFirst(t, '      id-token: write\n', '      id-token: write\n      contents: write\n') },
  { name: 'top permissions not empty', mutate: (t) => replaceFirst(t, 'permissions: {}\n', 'permissions: write-all\n') },
  { name: 'cancel in progress', mutate: (t) => replaceFirst(t, 'cancel-in-progress: false', 'cancel-in-progress: true') },
  {
    name: 'registry-url',
    mutate: (t) => replaceFirst(t, '          node-version: 24\n', '          node-version: 24\n          registry-url: https://registry.npmjs.org\n'),
  },
  { name: 'third-party action', mutate: (t) => replaceFirst(t, 'actions/setup-node@v5', 'docker/login-action@v3') },
  { name: 'publish in verify', mutate: (t) => replaceFirst(t, '\n  npm:\n', '\n      - run: npm publish\n\n  npm:\n') },
  { name: 'other registry', mutate: (t) => replaceAllOf(t, 'ghcr.io/ok0/superagent-claude:$tag', 'ghcr.io/other/superagent-claude:$tag') },
  {
    name: 'missing ci gate',
    mutate: (t) => replaceFirst(t, '        run: node scripts/release.ts ci-gate "$GITHUB_SHA"\n', '        run: echo skipped\n'),
  },
  { name: 'missing check:all', mutate: (t) => replaceFirst(t, 'run: pnpm check:all', 'run: pnpm test') },
  {
    name: 'missing dist-tag check',
    mutate: (t) => {
      const start = t.indexOf('      - name: verify dist-tag\n');
      const end = t.indexOf('\n  image:\n');
      return t.slice(0, start) + t.slice(end);
    },
  },
  { name: 'secrets in npm', mutate: (t) => replaceFirst(t, '      DIST_TAG: ${{ needs.verify.outputs.dist_tag }}\n', '      DIST_TAG: ${{ needs.verify.outputs.dist_tag }}\n      X: ${{ secrets.X }}\n') },
  { name: 'oidc without provenance', mutate: (t) => replaceFirst(t, 'npm publish --provenance', 'npm publish') },
  {
    name: 'oidc runs even when published',
    mutate: (t) => replaceFirst(t, "        if: steps.published.outputs.exists == 'false'\n        run: npm publish", '        run: npm publish'),
  },
  {
    name: 'bootstrap step re-added',
    mutate: (t) =>
      replaceFirst(
        t,
        '      - name: verify dist-tag\n',
        "      - name: publish (bootstrap token)\n        if: steps.published.outputs.exists == 'false'\n        run: npm publish --tag \"$DIST_TAG\" --access public\n      - name: verify dist-tag\n",
      ),
  },
  { name: 'npmrc in npm job', mutate: (t) => replaceFirst(t, '        run: pnpm build\n', '        run: pnpm build && touch .npmrc\n') },
  { name: 'release without --verify-tag', mutate: (t) => replaceAllOf(t, ' --verify-tag', '') },
  { name: 'npm too old', mutate: (t) => replaceFirst(t, 'npm@11.6.2', 'npm@11.4.0') },
  { name: 'checkout keeps credentials', mutate: (t) => replaceFirst(t, 'persist-credentials: false', 'persist-credentials: true') },
];

describe('release workflow', () => {
  it('the real workflow has no problems', () => {
    expect(releaseWorkflowProblems(real)).toEqual([]);
  });

  it('the npm job has one OIDC publish step and no secrets', () => {
    const npm = jobText(real, 'npm') ?? '';
    expect(real).not.toMatch(SECRETS_CONTEXT);
    expect(steps(npm).filter((s) => s.includes('npm publish'))).toHaveLength(1);
    expect(stepNamed(npm, 'publish (oidc)')).toContain('--provenance');
    expect(stepNamed(npm, 'publish (bootstrap token)')).toBeUndefined();
    expect(real).not.toMatch(/bootstrap|NPM_TOKEN|\.npmrc/i);
  });

  it('secret checks match only the ${{ secrets }} context', () => {
    expect(SECRETS_CONTEXT.test('run: bash scripts/check-image-secrets.sh superagent-claude:release')).toBe(false);
    for (const ref of ['${{ secrets.X }}', '${{secrets.X}}', '${{ toJSON(secrets) }}', "${{ secrets['X'] }}"]) {
      expect(SECRETS_CONTEXT.test(ref)).toBe(true);
    }
    const script = replaceFirst(real, OIDC_RUN, `${OIDC_RUN} && bash scripts/check-image-secrets.sh superagent-claude:release`);
    expect(script).not.toBe(real);
    expect(releaseWorkflowProblems(script)).toEqual([]);
    const secret = replaceFirst(real, OIDC_RUN, `${OIDC_RUN} && echo \${{ secrets.X }}`);
    const problems = releaseWorkflowProblems(secret);
    expect(problems.filter((p) => p.startsWith('oidc step must not use'))).toHaveLength(1);
    expect(problems.filter((p) => p.startsWith('secrets reference not allowed'))).toHaveLength(1);
  });

  it('publishing jobs cannot run before verify, and verify publishes nothing', () => {
    for (const job of ['npm', 'image', 'release'] as const) {
      expect(needsOf(jobText(real, job) ?? '')).toContain('verify');
    }
    const verify = jobText(real, 'verify') ?? '';
    expect(verify).not.toContain('npm publish');
    expect(verify).not.toContain('docker push');
    expect(verify).not.toContain('gh release create');
    expect(verify).toContain('run: node scripts/release.ts ci-gate "$GITHUB_SHA"');
    expect(verify).toContain('pnpm check:all');
    expect(verify).toContain('node scripts/release.ts pack-check');
    expect(verify).toContain('node scripts/changelog.ts notes "$VERSION"');
    expect(verify).toContain(DOCKER_BUILD_LINE);
    expect(verify).toContain('node scripts/release.ts verify-tag "$GITHUB_REF_NAME"');
  });

  it.each(MUTATIONS)('rejects a workflow with $name', ({ mutate }) => {
    const mutated = mutate(real);
    expect(mutated).not.toBe(real);
    expect(releaseWorkflowProblems(mutated).length).toBeGreaterThan(0);
  });
});

describe('actionlint (optional)', () => {
  const probe = spawnSync('actionlint', ['-version'], { encoding: 'utf8' });
  const available = probe.error === undefined && probe.status === 0;
  if (!available) {
    console.info('SKIP actionlint: not installed. Install with: brew install actionlint (or: go install github.com/rhysd/actionlint/cmd/actionlint@latest)');
  }

  it.skipIf(!available)('release.yml passes actionlint', () => {
    const result = spawnSync('actionlint', ['.github/workflows/release.yml'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status, result.stdout).toBe(0);
  });
});
