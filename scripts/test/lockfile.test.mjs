import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Adding a workspace to package.json without regenerating package-lock.json
// leaves everything green locally — node_modules already has the workspace
// linked, so the tests pass, the build passes and the publication gate passes.
// Only the CI's `npm ci` refuses, because it is the one command that insists
// the two files agree.
//
// This has now happened twice: once for `edge`, once for `cli`. Both times the
// push went out, CI went red on its first step, and the fix was a one-line
// lockfile commit. This moves that discovery to before the push.

const root = new URL('../../', import.meta.url)

async function readBoth() {
  return {
    pkg: JSON.parse(await readFile(new URL('package.json', root), 'utf8')),
    lock: JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8')),
  }
}

test('every workspace in package.json has a node in package-lock.json', async () => {
  const { pkg, lock } = await readBoth()

  const declared = pkg.workspaces ?? []
  assert.ok(declared.length > 0, 'package.json declares no workspaces')

  const missing = declared.filter((name) => !(name in (lock.packages ?? {})))
  assert.deepEqual(
    missing,
    [],
    `run \`npm install\` and commit package-lock.json — missing from the lock: ${missing.join(', ')}`
  )
})

test('the lockfile carries no workspace package.json no longer declares', async () => {
  const { pkg, lock } = await readBoth()

  // A stale entry is the same desync in the other direction: `npm ci` would
  // install a workspace that is no longer in the tree.
  const declared = new Set(pkg.workspaces ?? [])
  const stale = Object.keys(lock.packages ?? {}).filter(
    (key) => key && !key.includes('node_modules') && !declared.has(key)
  )

  assert.deepEqual(stale, [], `lockfile has workspaces package.json does not declare: ${stale.join(', ')}`)
})
