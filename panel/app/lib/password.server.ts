import { hash, verify } from '@node-rs/argon2'
import type { Algorithm, Options } from '@node-rs/argon2'

// Argon2id is spelled as a cast literal rather than the library's
// `Algorithm.Argon2id`: that enum is declared `const enum` in the .d.ts and its
// runtime export is an empty object, so the member reads as undefined under any
// transpiler that cannot inline a cross-file const enum — which is every
// toolchain this package is built with. The `$argon2id$` prefix is asserted in
// the tests, so a regression here fails loudly instead of silently downgrading
// to another variant.
const ARGON2ID = 2 as Algorithm

// OWASP's Argon2id baseline: 19 MiB of memory, two passes, one lane. Pinned in
// one exported constant because the values are baked into every digest ever
// written — a call site that quietly used a different cost would split the
// store into hashes nobody can account for.
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const satisfies Options

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_PARAMS)
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    // No parameters are passed on purpose: the cost is encoded in the stored
    // digest, and verification has to follow the digest it was given. Forcing
    // the current policy here would invalidate every password the moment the
    // cost is raised.
    return await verify(hashed, plain)
  } catch {
    // A stored digest can be truncated, hand-edited, or written by an older
    // scheme. Every one of those means "this is not a valid credential", and
    // must read that way — a thrown error would turn the login route into a 500
    // and hand an attacker a way to probe which accounts carry a broken hash.
    return false
  }
}
