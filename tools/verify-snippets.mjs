#!/usr/bin/env node
// Snippet-verification harness for the bilingual Next.js Deep Dive course.
//
// Next.js has no in-browser playground, so the only way to prove a lesson's
// code snippets actually compile is a real Next.js project ("the probe",
// tools/probe/) plus `tsc --noEmit` (fast, every fence) and `next build`
// (slow, one lesson at a time, for build-level claims).
//
// Usage:
//   node tools/verify-snippets.mjs                 type-check every collected
//                                                   fence from src/content/docs/en
//   node tools/verify-snippets.mjs --refresh        wipe + rescaffold tools/probe first
//   node tools/verify-snippets.mjs --build <module>/<lesson>
//                                                   `next build` with one lesson's
//                                                   fences dropped into the real probe tree
//   node tools/verify-snippets.mjs --self-test      harness self-check (see selfTest())
//
// Fence convention (spec §1.1.4 / §5.0): a fence in `tsx|ts|js|mjs` whose
// FIRST line is a path comment (`^// <path>\.(tsx|ts|js|mjs)$`) is a real
// file and gets collected. A first line containing `@expect-error` is a
// deliberate-error demo and is skipped (the lesson prose carries the real
// output). Anything else is a fragment with no path comment and is skipped
// (still fine to skip today — Phase 3 hasn't retrofitted path comments yet).
//
// `@/` import namespacing (documented per spec's requirement): in type-check
// mode every collected fence is written into its own namespace dir
// (`lessons/<module>__<lesson>/<path>`) so two lessons can each define
// `app/actions.ts` without colliding. That means the probe's single global
// `@/*` -> `tools/probe/*` path alias would resolve a lesson's `@/lib/db` to
// the real probe root, not to that lesson's own `lessons/<ns>/lib/db.ts`. We
// chose to REWRITE `@/`-specifiers at write time into a relative path rooted
// at the lesson's own namespace dir, rather than generating a `paths` entry
// per namespace — a per-namespace `paths` map can't be done with a single
// static tsconfig because every lesson reuses the same bare specifiers
// (`@/lib/db` means something different in each lesson). A relative rewrite
// is a plain string replace, needs no tsconfig codegen, and is trivially
// correct. `--build` mode does NOT rewrite: it drops files at their real
// path directly under tools/probe/, where the scaffold's own `@/*` alias
// already means what the lesson intends.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PROBE_DIR = path.join(REPO_ROOT, 'tools/probe');
const LESSONS_DIR = path.join(PROBE_DIR, 'lessons');
const DOCS_EN = path.join(REPO_ROOT, 'src/content/docs/en');

// Packages lessons `import` that `create-next-app`'s default scaffold does not
// ship (found via: grep -rho "from '[^']*'" src/content/docs/en | sort | uniq -c).
// Documented in README.md's Harness section too.
const EXTRA_PACKAGES = ['zod'];

const FENCE_LANGS = new Set(['tsx', 'ts', 'js', 'mjs']);
const PATH_RE = /^\/\/ ([\w@.\-[\]()/]+\.(tsx|ts|js|mjs))$/;

// ---------------------------------------------------------------------------
// String/bracket scanning helpers, ported from tools/check-parity.mjs (same
// technique that file uses to keep quiz-array template literals from
// confusing a naive fence regex: walk the source honoring string literals so
// brackets/backticks *inside* a string never look like real structure).
// ---------------------------------------------------------------------------

function parseStringAt(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    j++;
  }
  return { end: j };
}

function scanBalanced(text, start, open, close) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = parseStringAt(text, i).end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) depth--;
    i++;
  }
  return i; // index right after the matching close
}

// Ranges of `export const xxx = [ ... ]` (quiz question arrays) and
// `<SpotTheBug code={\` ... \`}>` template literals. Fences found in the
// stripped text touch neither, because a `q`/`explain` string can legally
// contain literal ``` sequences (```fence in `q` per spec §1.1.4 item 8) and
// a naive regex would otherwise pair a real closing fence with one embedded
// in a quiz string, corrupting every fence found afterwards in the file.
function findExcludedRanges(src) {
  const ranges = [];
  {
    const re = /export\s+const\s+\w+\s*=\s*\[/g;
    let m;
    while ((m = re.exec(src))) {
      const end = scanBalanced(src, re.lastIndex, '[', ']');
      ranges.push([m.index, end]);
      re.lastIndex = end;
    }
  }
  {
    const re = /<SpotTheBug\s+code=\{\s*`/g;
    let m;
    while ((m = re.exec(src))) {
      const backtickIdx = m.index + m[0].length - 1;
      const { end } = parseStringAt(src, backtickIdx);
      ranges.push([m.index, end]);
      re.lastIndex = end;
    }
  }
  return ranges;
}

// Blank out excluded ranges but keep every newline they contain, so line
// numbers computed on the result still match the original file.
function stripExcluded(src, ranges) {
  if (!ranges.length) return src;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue; // overlapping/malformed match, ignore
    out += src.slice(cursor, start);
    out += src.slice(start, end).replace(/[^\n]/g, '');
    cursor = end;
  }
  out += src.slice(cursor);
  return out;
}

function countNewlinesBefore(s, upto) {
  let n = 0;
  for (let i = 0; i < upto; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Collect every fenced code block in one MDX file's source.
// Returns [{ fenceNum, lang, line, category, path?, body? }], fenceNum is
// 1-based over ALL real fences (any language) in document order — the same
// count a person would get scrolling the file and counting ``` blocks.
function collectFences(rawSrc) {
  const src = stripExcluded(rawSrc, findExcludedRanges(rawSrc));
  const fenceRe = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  const results = [];
  let fenceNum = 0;
  let m;
  while ((m = fenceRe.exec(src))) {
    fenceNum++;
    const lang = m[1];
    if (!FENCE_LANGS.has(lang)) continue; // out of scope for this harness
    const body = m[2];
    const line = countNewlinesBefore(src, m.index) + 1;
    const firstLine = body.split('\n', 1)[0].trim();
    if (firstLine.includes('@expect-error')) {
      results.push({ fenceNum, lang, line, category: 'expect-error' });
      continue;
    }
    const pm = PATH_RE.exec(firstLine);
    if (pm) {
      results.push({ fenceNum, lang, line, category: 'collected', path: pm[1], body });
    } else {
      results.push({ fenceNum, lang, line, category: 'skipped-no-path' });
    }
  }
  return results;
}

// Rewrite `@/foo` specifiers in a fence body into a path relative to `dir`
// (the file's own directory within its namespace), so the file resolves
// against its lesson's private `lessons/<ns>/` root instead of the probe's
// real `@/*` -> repo-root alias. See file-header note for why this approach
// (vs. per-namespace tsconfig `paths`) was chosen.
function rewriteAtSpecifiers(content, relPath) {
  const dir = path.posix.dirname(relPath.replaceAll('\\', '/'));
  let prefix = path.posix.relative(dir, '.');
  prefix = prefix === '' ? './' : `${prefix}/`;
  return content.replace(
    /\b(from|import|require)(\s*\(?\s*)(['"])@\/([^'"]*)\3/g,
    (_whole, kw, ws, q, tail) => `${kw}${ws}${q}${prefix}${tail}${q}`,
  );
}

// ---------------------------------------------------------------------------
// Probe lifecycle
// ---------------------------------------------------------------------------

function ensureProbe(refresh) {
  if (refresh && existsSync(PROBE_DIR)) rmSync(PROBE_DIR, { recursive: true, force: true });
  if (!existsSync(PROBE_DIR)) {
    console.log('tools/probe missing — scaffolding with create-next-app@latest (this takes a minute)...');
    const res = spawnSync(
      'npx',
      [
        '-y',
        'create-next-app@latest',
        'probe',
        '--ts',
        '--app',
        '--no-eslint',
        '--no-tailwind',
        '--no-src-dir',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
      { cwd: path.join(REPO_ROOT, 'tools'), stdio: 'inherit' },
    );
    if (res.status !== 0) {
      console.error('probe scaffold failed');
      process.exit(1);
    }
    // create-next-app initializes its own git repo inside tools/probe; this
    // repo already gitignores tools/probe/ wholesale, so drop the nested repo.
    rmSync(path.join(PROBE_DIR, '.git'), { recursive: true, force: true });
  }
  patchTsconfig();
  installExtraPackages();
}

function patchTsconfig() {
  const tsconfigPath = path.join(PROBE_DIR, 'tsconfig.json');
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  if (!tsconfig.include.includes('lessons/**/*')) {
    tsconfig.include.push('lessons/**/*');
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  }
}

function installExtraPackages() {
  for (const pkg of EXTRA_PACKAGES) {
    if (!existsSync(path.join(PROBE_DIR, 'node_modules', pkg))) {
      console.log(`installing missing lesson dependency into probe: ${pkg}`);
      spawnSync('npm', ['install', '--save-dev', '--no-audit', '--no-fund', pkg], {
        cwd: PROBE_DIR,
        stdio: 'inherit',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Lesson discovery
// ---------------------------------------------------------------------------

function discoverLessons() {
  const rels = globSync('**/*.mdx', { cwd: DOCS_EN }).sort();
  return rels.map((rel) => {
    const posixRel = rel.replaceAll('\\', '/');
    return {
      absPath: path.join(DOCS_EN, rel),
      mdxRelPath: `src/content/docs/en/${posixRel}`,
      module: posixRel.split('/')[0],
      lesson: path.basename(posixRel, '.mdx'),
    };
  });
}

// ---------------------------------------------------------------------------
// Type-check mode (default)
// ---------------------------------------------------------------------------

function runTypeCheck(descriptors) {
  rmSync(LESSONS_DIR, { recursive: true, force: true });
  mkdirSync(LESSONS_DIR, { recursive: true });

  const fenceMap = new Map(); // namespace -> { mdxRelPath, fences: Map(relPath -> fenceNum) }
  const stats = new Map(); // module -> { collected, skippedNoPath, expectError }

  for (const d of descriptors) {
    const counters = stats.get(d.module) ?? { collected: 0, skippedNoPath: 0, expectError: 0 };
    stats.set(d.module, counters);

    const namespace = `${d.module}__${d.lesson}`;
    const nsFences = new Map();
    const src = readFileSync(d.absPath, 'utf8');

    for (const f of collectFences(src)) {
      if (f.category === 'collected') {
        counters.collected++;
        nsFences.set(f.path, f.fenceNum);
        const destAbs = path.join(LESSONS_DIR, namespace, f.path);
        mkdirSync(path.dirname(destAbs), { recursive: true });
        writeFileSync(destAbs, rewriteAtSpecifiers(f.body, f.path));
      } else if (f.category === 'skipped-no-path') {
        counters.skippedNoPath++;
      } else if (f.category === 'expect-error') {
        counters.expectError++;
      }
    }
    fenceMap.set(namespace, { mdxRelPath: d.mdxRelPath, fences: nsFences });
  }

  const tscBin = path.join(PROBE_DIR, 'node_modules', '.bin', 'tsc');
  const res = spawnSync(tscBin, ['--noEmit', '--pretty', 'false'], { cwd: PROBE_DIR, encoding: 'utf8' });
  if (res.error) {
    console.error('failed to run tsc in the probe:', res.error.message);
    process.exit(1);
  }

  const diagLine = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
  const diagnostics = [];
  let dm;
  const stdout = res.stdout ?? '';
  while ((dm = diagLine.exec(stdout))) {
    const [, file, line, col, code, message] = dm;
    const norm = file.replaceAll('\\', '/');
    const lm = /^lessons\/([^/]+)\/(.+)$/.exec(norm);
    const info = lm && fenceMap.get(lm[1]);
    const mapped = info ? { mdxRelPath: info.mdxRelPath, relPath: lm[2], fenceNum: info.fences.get(lm[2]) } : null;
    diagnostics.push({ file: norm, line, col, code, message, mapped });
  }

  if (diagnostics.length) {
    console.log(`\n${diagnostics.length} type error(s):\n`);
    for (const d of diagnostics) {
      if (d.mapped) {
        console.log(
          `${d.mapped.mdxRelPath}:fence #${d.mapped.fenceNum} (${d.mapped.relPath}) ` +
            `— probe:${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`,
        );
      } else {
        console.log(`[unmapped] ${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`);
      }
    }
  } else if (res.status !== 0) {
    console.log('\ntsc exited non-zero but no parseable diagnostics were found; raw output:\n');
    console.log(stdout, res.stderr ?? '');
  } else {
    console.log('\nno type errors.');
  }

  printStats(stats);

  return { errorCount: diagnostics.length || (res.status !== 0 ? 1 : 0), diagnostics, stats };
}

function printStats(stats) {
  console.log('\nPer-module fence summary (collected / skipped-no-path / expect-error):');
  const totals = { collected: 0, skippedNoPath: 0, expectError: 0 };
  for (const [module, c] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${module}: ${c.collected} / ${c.skippedNoPath} / ${c.expectError}`);
    totals.collected += c.collected;
    totals.skippedNoPath += c.skippedNoPath;
    totals.expectError += c.expectError;
  }
  console.log(`  TOTAL: ${totals.collected} / ${totals.skippedNoPath} / ${totals.expectError}`);
}

// ---------------------------------------------------------------------------
// --build <module>/<lesson>: real `next build` for one lesson
// ---------------------------------------------------------------------------

function buildMode(target) {
  if (!target) {
    console.error('usage: node tools/verify-snippets.mjs --build <module>/<lesson>');
    process.exit(1);
  }
  const parts = target.split('/');
  const lesson = parts.pop();
  const module = parts.join('/');
  const mdxAbs = path.join(DOCS_EN, module, `${lesson}.mdx`);
  if (!existsSync(mdxAbs)) {
    console.error(`lesson not found: ${mdxAbs}`);
    process.exit(1);
  }

  const fences = collectFences(readFileSync(mdxAbs, 'utf8')).filter((f) => f.category === 'collected');
  if (!fences.length) {
    console.log(`${target}: no path-comment fences to build`);
    process.exit(0);
  }

  const backups = new Map(); // relPath -> original content Buffer, or null if the file didn't exist
  for (const f of fences) {
    const dest = path.join(PROBE_DIR, f.path);
    backups.set(f.path, existsSync(dest) ? readFileSync(dest) : null);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.body); // real probe tree: `@/*` already means the probe root, no rewrite needed
  }

  console.log(`building probe with ${fences.length} fence(s) from ${target}: ${fences.map((f) => f.path).join(', ')}`);
  const res = spawnSync(path.join(PROBE_DIR, 'node_modules', '.bin', 'next'), ['build'], {
    cwd: PROBE_DIR,
    encoding: 'utf8',
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  console.log(output.split('\n').slice(-40).join('\n'));

  for (const [relPath, original] of backups) {
    const dest = path.join(PROBE_DIR, relPath);
    if (original === null) rmSync(dest, { force: true });
    else writeFileSync(dest, original);
  }

  process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

function selfTest() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'verify-snippets-selftest-'));
  const badPath = path.join(tmpDir, 'bad.mdx');
  const goodPath = path.join(tmpDir, 'good.mdx');
  writeFileSync(
    badPath,
    ['---', 'title: selftest', '---', '', '```ts', '// selftest/bad.ts', 'const x: number = "not a number";', 'export default x;', '```', ''].join(
      '\n',
    ),
  );
  writeFileSync(goodPath, ['```ts', '// selftest/good.ts', 'const y: number = 1;', 'export default y;', '```', ''].join('\n'));

  const descriptors = [
    { absPath: badPath, mdxRelPath: 'selftest/bad.mdx', module: '__selftest__', lesson: 'bad' },
    { absPath: goodPath, mdxRelPath: 'selftest/good.mdx', module: '__selftest__', lesson: 'good' },
  ];

  const { diagnostics } = runTypeCheck(descriptors);
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(LESSONS_DIR, { recursive: true, force: true });

  const badFailed = diagnostics.some((d) => d.mapped?.mdxRelPath === 'selftest/bad.mdx');
  const goodFailed = diagnostics.some((d) => d.mapped?.mdxRelPath === 'selftest/good.mdx');

  if (badFailed && !goodFailed) {
    console.log('\nself-test: PASS (bad fence failed type-check as expected, good fence passed)');
    process.exit(0);
  }
  console.error('\nself-test: FAIL', { badFailed, goodFailed });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  ensureProbe(args.includes('--refresh'));

  if (args.includes('--self-test')) return selfTest();

  const buildIdx = args.indexOf('--build');
  if (buildIdx !== -1) return buildMode(args[buildIdx + 1]);

  const { errorCount } = runTypeCheck(discoverLessons());
  process.exit(errorCount > 0 ? 1 : 0);
}

main();
