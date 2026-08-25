import { hashPassword, verifyPassword } from './password.server.ts'

// Two protections the sign-in form was missing, and they are related: both are
// about what an attacker learns from a failed attempt.

// -- 1. A password attempt costs something -----------------------------------
//
// Nothing limited attempts. Argon2id makes each one expensive for the server,
// which slows an attacker down but also means a flood of guesses is a denial of
// service against the panel: the cost lands on the defender either way.
//
// The counter is in memory, deliberately. A self-hosted panel is one process,
// and a database table for this would put a write on the path of every failed
// login, which is exactly the path whose volume an attacker controls. The
// tradeoff is stated rather than hidden: a restart clears the counters.

const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10
const MAX_TRACKED = 10_000

const attempts = new Map<string, { count: number; first: number }>()

function prune(now: number): void {
  for (const [key, entry] of attempts) {
    if (now - entry.first > WINDOW_MS) attempts.delete(key)
  }
  // A bound the attacker cannot push past: they choose the keys, so an
  // unbounded map is memory they get to allocate on the server.
  if (attempts.size > MAX_TRACKED) {
    const oldest = [...attempts.entries()].sort((a, b) => a[1].first - b[1].first)
    for (const [key] of oldest.slice(0, attempts.size - MAX_TRACKED)) attempts.delete(key)
  }
}

/** Keyed on address AND source, so one attacker cannot lock out a real user. */
export function attemptKey(email: string, ip: string | null): string {
  const source = (ip ?? '').split(',').pop()?.trim() ?? ''
  return `${email.trim().toLowerCase()} ${source}`
}

export function isLockedOut(key: string, now = Date.now()): boolean {
  prune(now)
  const entry = attempts.get(key)
  if (!entry) return false
  if (now - entry.first > WINDOW_MS) {
    attempts.delete(key)
    return false
  }
  return entry.count >= MAX_ATTEMPTS
}

export function recordFailure(key: string, now = Date.now()): void {
  const entry = attempts.get(key)
  if (!entry || now - entry.first > WINDOW_MS) attempts.set(key, { count: 1, first: now })
  else entry.count += 1
}

export function clearFailures(key: string): void {
  attempts.delete(key)
}

/** Test seam: the counters are process state, and a test must start from zero. */
export function resetGuard(): void {
  attempts.clear()
}

// -- 2. A failure takes the same time either way ------------------------------
//
// The route promised that an unknown address and a wrong password fail
// identically, so the form cannot be used to discover who has an account. The
// text was identical; the timing was not. With no user row, verifyPassword was
// never called, so the answer came back in about a millisecond instead of the
// ~100ms Argon2id costs, and that difference is readable over the network. It
// made the form a membership oracle regardless of what the message said.
//
// So a miss verifies against a real hash of a value nobody can supply. The work
// is identical because it is the same work.

let decoyHash: Promise<string> | null = null

function decoy(): Promise<string> {
  if (!decoyHash) {
    // Hashed once per process, from a value no caller can reach.
    decoyHash = hashPassword(`decoy:${process.pid}:${Date.now()}`)
  }
  return decoyHash
}

/**
 * Verify, spending the same effort whether or not the account exists.
 *
 * Returns false for a missing hash only AFTER doing the work, so a caller
 * cannot accidentally reintroduce the shortcut.
 */
export async function verifyOrBurn(hash: string | null | undefined, password: string): Promise<boolean> {
  if (hash) return verifyPassword(hash, password)
  await verifyPassword(await decoy(), password)
  return false
}
