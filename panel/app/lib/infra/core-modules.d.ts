// The `core` workspace is plain ESM JavaScript and this tsconfig compiles only
// TypeScript, so an import of the vault is an implicit `any` that strict mode
// rejects outright. Declaring the two modules here keeps the credential path
// typed without turning on `allowJs` for the whole panel — which would pull
// every .mjs in the repository into the panel's type graph — and without a
// second copy of the implementation that could drift from the real one.

declare module '@linkyard/core/secret' {
  export class Secret {
    constructor(value: string)
    reveal(): string
    toString(): string
    toJSON(): string
  }
  export function isSecret(value: unknown): value is Secret
}

declare module '@linkyard/core/vault' {
  import type { Secret } from '@linkyard/core/secret'
  export function deriveKey(masterKey: string): Buffer
  export function seal(key: Buffer, plaintext: string | Secret): Buffer
  export function open(key: Buffer, sealed: Buffer): Secret
  export function last4(value: string | Secret): string
}
