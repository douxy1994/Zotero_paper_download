import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import * as io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';

const exec = promisify(execFile);
const code = fs.readFileSync('skill-fulltext-downloader.js', 'utf8');
const DOI = '10.1039/c4sc02365j';
const RUN = '34bb8c67-efe8-42da-9f44-d890ef83d666';
const work = await io.mkdtemp(path.join(await io.realpath(os.tmpdir()), 'paper-fetch82-'));
const dir = path.join(work, 'output');
const body = path.join(dir, '.paper-fetch-results', RUN, '1', 'body.md');
const receiptFile = path.join(dir, 'full.stdout.log');
const legacyFile = path.join(dir, 'full.json');
const goodReceipt = {
  contract: 'paper-fetch/receipt', schema_version: 2, index: 1, query: DOI,
  status: 'completed', target_satisfied: true, error: null, truncated: false,
  content_kind: 'fulltext', body_path: body, identity: { status: 'resolved', doi: DOI },
  acceptance: { overall: 'complete', identity: 'resolved', fetch: 'ok', has_fulltext: true },
  acquisition: { provider: 'rsc', representation: 'html' },
};

const context = vm.createContext({
  Zotero: { debug() {} },
  PathUtils: { join: path.join },
  IOUtils: {
    exists: async p => fs.existsSync(p),
    readUTF8: async p => io.readFile(p, 'utf8'),
    getChildren: async p => (await io.readdir(p)).map(f => path.join(p, f)),
    stat: async p => {
      const stat = await io.lstat(p);
      return { size: stat.size, type: stat.isFile() ? 'regular' : stat.isDirectory() ? 'directory' : 'other' };
    },
  },
});
vm.runInContext(code + ';this.plugin = SkillFulltextDownloader', context);
const p = context.plugin;

try {
  await io.mkdir(path.dirname(body), { recursive: true });
  await io.writeFile(body, '# Verified RSC article\n');
  await io.writeFile(path.join(dir, 'stale.pdf'), '%PDF-stale');
  await io.writeFile(path.join(dir, 'stale.md'), '# Stale');
  await io.writeFile(legacyFile, '{"quality":{"has_fulltext":true}}');
  await io.writeFile(legacyFile + '.receipt-mode', '');
  const select = async (overrides, mode = 'markdown-assets', query = DOI) => {
    await io.writeFile(receiptFile, JSON.stringify({ ...goodReceipt, ...overrides }));
    return p._paperFetchAttachment(dir, legacyFile, receiptFile, query, mode);
  };

  assert.equal(await select(), body);
  const trackedURL = 'https://doi.org/' + DOI + '?utm_source=zotero';
  const resolved = { ...goodReceipt.identity, expected_doi: DOI };
  assert.equal(await select({ query: trackedURL, identity: resolved }, 'none', trackedURL), body);
  assert.equal(await select({ query: trackedURL, identity: { ...resolved, doi: '10.1039/wrong' } },
    'none', trackedURL), null);
  assert.equal(await select({ acceptance: { ...goodReceipt.acceptance, overall: 'degraded' } }), body);
  for (const bad of [
    { status: 'failed' }, { schema_version: 99 }, { query: '10.1039/wrong' },
    { truncated: true }, { target_satisfied: false }, { content_kind: 'abstract_only' },
    { content_kind: 'metadata_only' }, { error: { reason: 'failed' } },
    { identity: { status: 'resolved', doi: '10.1039/wrong' } },
    { identity: { status: 'mismatch', doi: DOI } },
    { acceptance: { ...goodReceipt.acceptance, overall: 'action_required' } },
    { acceptance: { ...goodReceipt.acceptance, target: 'supplementary' } },
    { body_path: path.join(dir, 'stale.md') }, { body_path: '/outside/body.md' },
    { body_path: path.join(dir, '.paper-fetch-results', RUN, '1', 'missing.md') },
  ]) assert.equal(await select(bad), null, JSON.stringify(bad));
  await io.writeFile(receiptFile, '{malformed');
  assert.equal(await p._paperFetchAttachment(dir, legacyFile, receiptFile, DOI, 'markdown-assets'), null);
  await io.unlink(receiptFile);
  assert.equal(await p._paperFetchAttachment(dir, legacyFile, receiptFile, DOI, 'markdown-assets'), null);
  console.log('PASS RSC full-text v2 receipt; reject stale, malformed, incomplete, truncated, off-directory and wrong-DOI results');

  const pdf = path.join(dir, 'article.pdf');
  await io.rename(path.join(dir, 'stale.pdf'), pdf);
  assert.equal(await select({ acquisition: { representation: 'pdf' } }), pdf);
  assert.equal(await select({ acquisition: { representation: 'pdf' } }, 'none'), body);
  await io.writeFile(path.join(dir, 'unrelated.pdf'), '%PDF-unrelated');
  assert.equal(await select({ acquisition: { representation: 'pdf' } }), body);
  console.log('PASS PDF route prefers a unique source, or uses the exact receipt Markdown');

  await select({ status: 'failed', error: { status: 'ambiguous', reason: 'Multiple matches' } });
  assert.match(await p._paperFetchFailureDetail([receiptFile]), /标题歧义/);
  await select({ content_kind: 'metadata_only' });
  assert.match(await p._paperFetchFailureDetail([receiptFile]), /仅返回元数据/);

  const executable = path.join(work, '.local/bin/paper-fetch');
  await io.mkdir(path.dirname(executable), { recursive: true });
  await io.writeFile(executable, '#!/bin/sh\nif [ "$1" = --version ]; then printf "paper-fetch %s\\n" "$FIXTURE_VERSION"; exit; fi\n' +
    'printf "%s\\n" "$@" > "$HOME/invocation"\n' +
    'if [ "${FIXTURE_EXIT:-0}" != 0 ]; then exit "$FIXTURE_EXIT"; fi\n', { mode: 0o755 });
  p._paperFetchAttachment = async () => body;
  let version = '8.2.0';
  const originalRun = async (exe, args) => exec(exe, args, {
    env: { ...process.env, HOME: work, ZDOTDIR: work, FIXTURE_VERSION: version },
  });
  p._runProcess = originalRun;
  const attempt = () => p._runPaperFetch(DOI, dir, legacyFile, receiptFile, path.join(dir, 'full.stderr.log'),
    path.join(dir, 'fallback.json'), path.join(dir, 'fallback.stdout.log'), path.join(dir, 'fallback.stderr.log'));
  await io.unlink(legacyFile + '.receipt-mode');
  assert.equal(await attempt(), body);
  let argv = (await io.readFile(path.join(work, 'invocation'), 'utf8')).trimEnd().split('\n');
  assert.deepEqual(argv, ['fetch', '--query', DOI, '--output-dir', dir, '--artifact-mode', 'markdown-assets',
    '--asset-profile', 'none', '--prefer-cache', '--overwrite']);
  assert.equal(fs.existsSync(legacyFile + '.receipt-mode'), true);
  await io.unlink(legacyFile + '.receipt-mode');
  version = '7.4.2';
  await attempt();
  argv = (await io.readFile(path.join(work, 'invocation'), 'utf8')).trimEnd().split('\n');
  assert.deepEqual(argv, ['fetch', '--query', DOI, '--format', 'json', '--output', legacyFile, '--output-dir',
    dir, '--save-markdown', '--artifact-mode', 'markdown-assets', '--asset-profile', 'body']);
  assert.equal(fs.existsSync(legacyFile + '.receipt-mode'), false);
  console.log('PASS /bin/zsh executes both actual version-specific argument lists and chooses the managed launcher');

  if (process.env.PAPER_FETCH82_RECEIPTS) {
    for (const file of process.env.PAPER_FETCH82_RECEIPTS.split(path.delimiter)) {
      const receipt = JSON.parse(await io.readFile(file, 'utf8'));
      const root = path.resolve(file, '..', path.basename(file, '.stdout.log'));
      const marker = path.join(dir, 'actual');
      await io.writeFile(marker + '.receipt-mode', '');
      // Restore actual selection after the command-only fixture.
      vm.runInContext(code, context);
      const selected = await context.SkillFulltextDownloader._paperFetchAttachment(root, marker, file,
        receipt.query, 'none');
      assert.equal(selected, receipt.target_satisfied ? receipt.body_path : null);
      console.log('PASS actual Paper Fetch receipt replay: ' + receipt.content_kind + ' / ' + receipt.query);
    }
  }
} finally {
  await io.rm(work, { recursive: true, force: true });
}
