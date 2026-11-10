import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let payload;
let sizes = new Map();
const context = {
  Zotero: { debug() {} },
  PathUtils: { join: path.posix.join },
  IOUtils: {
    exists: async file => file === '/work/result.json',
    readUTF8: async () => JSON.stringify(payload),
    stat: async file => ({ size: sizes.get(file) ?? 100 }),
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('skill-fulltext-downloader.js', 'utf8') + ';this.p=SkillFulltextDownloader', context);
const p = context.p;
let files;
p._listFilesRecursive = async () => files;
const select = () => p._pickAttachmentFile('/work', ['/work/result.json']);

files = ['/work/README.md', '/work/partial.pdf'];
for (const quality of [
  { has_fulltext: false, content_kind: 'metadata_only' },
  { has_fulltext: false, content_kind: 'abstract_only' },
  { content_kind: 'metadata_only' },
]) {
  payload = { quality };
  assert.equal(await select(), null);
  assert.equal(await p._hasFile('/work', ['/work/result.json']), false);
}
console.log('PASS metadata/abstract JSON rejects leftover PDFs and Markdown even after exit 0');

payload = { quality: { has_fulltext: true, content_kind: 'fulltext' }, assets: [{ path: '/work/figure.pdf' }] };
files = ['/work/article.md', '/work/figure.pdf', '/work/paper-assets/table.pdf', '/work/diagnostics/readme.md', '/work/supplementary/large.pdf'];
sizes = new Map(files.map((f, i) => [f, 10000 * (i + 1)]));
assert.equal(await select(), '/work/article.md');
files.push('/work/article.pdf');
assert.equal(await select(), '/work/article.pdf');
console.log('PASS article PDF preferred; figure/supplement PDFs and diagnostic Markdown excluded');

payload.assets = [{ path: 'figure.pdf' }];
files = ['/work/figure.pdf', '/work/article.md'];
assert.equal(await select(), '/work/article.md');
payload = { status: 'error', quality: { has_fulltext: true } };
assert.equal(await select(), null);
payload = { article: { quality: { has_fulltext: true }, assets: [] }, acceptance: { overall: 'failed' } };
assert.equal(await select(), null);
payload.acceptance.overall = 'degraded';
assert.equal(await select(), '/work/figure.pdf');
console.log('PASS relative asset paths, failed/degraded envelopes, and legacy article JSON handled');

context.IOUtils.readUTF8 = async () => '{bad';
assert.equal(await select(), null);
context.IOUtils.exists = async () => false;
assert.equal(await select(), null);
assert.equal(await p._pickAttachmentFile('/work'), '/work/figure.pdf');
console.log('PASS malformed/missing result rejects Paper-fetch; ScanSci file-only selection unchanged');

// Exercise command construction rather than merely matching source strings.
let calls = [];
p._runProcess = async (command, args, timeout) => { calls.push({ command, args, timeout }); };
p._hasFile = async () => calls.length > 1;
p.cancelled = false;
await p._runPaperFetch('10.0000/query; never-shell-eval', '/work', '/work/result.json', '/full.out', '/full.err', '/fallback.json', '/fallback.out', '/fallback.err');
assert.equal(calls.length, 2);
assert.equal(calls[0].command, '/bin/zsh');
assert.equal(calls[0].args[3], '10.0000/query; never-shell-eval');
assert.match(calls[0].args[1], /\$HOME\/\.local\/bin/);
assert.match(calls[0].args[1], /fetch --query "\$1"/);
assert.match(calls[0].args[1], /--artifact-mode markdown-assets --asset-profile body/);
assert.match(calls[1].args[1], /--artifact-mode none/);
assert.equal(calls[0].timeout, 1080000);
assert.equal(calls[1].timeout, 60000);
console.log('PASS 7.4.2 CLI flags, private-bin discovery, argument quoting, and both timeout budgets');

// Optional real CLI result replay, including the metadata-only Fake-IP response.
if (process.env.PAPER_FETCH_RESULT) {
  const real = JSON.parse(fs.readFileSync(process.env.PAPER_FETCH_RESULT, 'utf8'));
  context.IOUtils.exists = async () => true;
  context.IOUtils.readUTF8 = async () => JSON.stringify(real);
  p._listFilesRecursive = async () => ['/work/stale.pdf'];
  assert.equal(await select(), null);
  console.log('PASS actual 7.4.2 metadata-only result does not import stale PDF');
}
