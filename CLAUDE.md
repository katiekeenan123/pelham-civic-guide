# Pelham Civic Guide — working rules

See README.md for the full commands table and where content lives.

## Before committing

1. `npm run build:check` — must pass. If it fails, run `npm run build` and
   commit the generated output; never edit `index.html` by hand.
2. `npm run test:local` — must pass.
3. `npm run verify:sources` — **always run before pushing.** It exits 0 even
   when it finds problems, so read the summary. Investigate any new 404 or
   homepage-only citation before committing: fix the URL, or say in the
   commit message why it stays.

## Village site verification

pelhamny.gov and pelhammanor.gov block some automated tools, so
`verify:sources` reports them as `403 Forbidden` rather than checking them.
Route verification of those pages through Claude Code, not the chat
interface: do it here, where the result can be checked against the content
files and committed together with any correction.
