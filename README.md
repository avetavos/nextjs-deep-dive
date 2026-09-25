# Next.js Deep Dive

Bilingual (EN/TH) Astro + Starlight course on the Next.js App Router.

## Scripts

- `npm run dev` / `npm run build` / `npm run preview` — Astro site.
- `npm run check` — EN/TH lesson parity (`tools/check-parity.mjs`): heading counts,
  quiz question/answer parity, Thai-language checks, byte-identical code fences.
- `npm run verify` — snippet-verification harness (`tools/verify-snippets.mjs`), see below.

## Harness

`@/` imports resolve inside the lesson first, then to the first lesson (in module order) that defines that path with a bare `// path` comment — so `app/lib/session.ts` is defined once in the auth lesson and imported everywhere else. Alternative versions of the same file use a decorated comment (`// app/lib/session.ts — database variant`) so they are shown but not collected.

Next.js has no in-browser playground, so lesson code can't be proven correct by
running it in the reader's tab. Instead, `tools/verify-snippets.mjs` drives a real
scaffolded Next.js project — the **probe**, at `tools/probe/` (gitignored) — and
type-checks or builds lesson snippets against it.

**Fence convention.** In `src/content/docs/en/**/*.mdx`, a fenced code block in
`tsx`/`ts`/`js`/`mjs` whose first line is a path comment (`// app/posts/page.tsx`,
`// proxy.ts`, ...) is treated as a real project file and gets collected. A first
line containing `@expect-error` marks a deliberate compile error (the lesson prose
carries the real error text); everything else is a fragment with no path comment
and is skipped. Fences inside a `<Quiz ... questions={[...]}>` array or a
`<SpotTheBug code={\`...\`}>` prop are never mistaken for real fences even when they
contain literal ``` sequences — the same string-literal-aware scanning
`tools/check-parity.mjs` already uses.

**Type-check mode (default):** `npm run verify`
Writes every collected fence to `tools/probe/lessons/<module>__<lesson>/<path>`
(namespaced per lesson, so two lessons can each define `app/actions.ts` without
colliding), then runs `tsc --noEmit` once for the whole probe. Diagnostics are
mapped back to `<lesson file>:fence #n (<path>)`. Exits non-zero on any error.
Prints a per-module summary of fences collected / skipped (no path comment) /
skipped (`@expect-error`).

A fence that imports `@/lib/x` is rewritten at write time to a path relative to
its own lesson namespace (e.g. `../../lib/x`), instead of relying on the probe's
global `@/*` -> repo-root alias — a single static alias can't disambiguate
`@/lib/db` meaning something different in every lesson, and a relative rewrite
needs no per-namespace tsconfig generation.

**Build mode:** `npm run verify -- --build <module>/<lesson>`
Copies one lesson's fences into the *real* probe tree (`tools/probe/app/...`,
backing up anything they overwrite) and runs `next build`, printing the tail of
the output (route table, warnings). Restores the backed-up files afterward
regardless of the build's outcome. Use this to prove a build-level claim
(a warning, a route symbol, an error) for one lesson.

**Self-test:** `npm run verify -- --self-test`
Runs the type-check path against a temporary lesson with one deliberately
broken fence and one correct fence, asserts the bad one fails and the good one
doesn't, then cleans up.

**Refresh the probe:** `npm run verify -- --refresh` wipes and rescaffolds
`tools/probe/` from `create-next-app@latest`.

**Probe dependencies.** The probe starts from `create-next-app@latest --ts --app
--no-eslint --no-tailwind --no-src-dir --import-alias '@/*'`. Lessons import a
few packages that scaffold doesn't ship; the harness installs them into the
probe automatically (see `EXTRA_PACKAGES` in `tools/verify-snippets.mjs`):

- `zod` — form/action validation examples in `server-actions-and-mutations` and
  `data-fetching-and-caching`.
