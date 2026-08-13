// A credential that cannot be printed by accident.
//
// The realistic way a token leaks is not an attacker — it is console.log(args)
// during a debugging session, or an HTTP client embedding the request (and its
// Authorization header) in a thrown error. Wrapping the value makes every
// serialization path yield '[redacted]', so the mistake becomes impossible
// rather than merely discouraged. The real value is reachable only through an
// explicit .reveal() call, which is easy to grep for in review.

const VALUE = Symbol('secret.value')

export class Secret {
  constructor(value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Secret requires a non-empty string')
    }
    // Non-enumerable and symbol-keyed: Object.keys, spread, and JSON.stringify
    // of a plain copy all come up empty.
    Object.defineProperty(this, VALUE, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  reveal() {
    return this[VALUE]
  }

  toString() {
    return '[redacted]'
  }

  toJSON() {
    return '[redacted]'
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return '[redacted]'
  }

  get [Symbol.toStringTag]() {
    return 'Secret'
  }
}

export function isSecret(value) {
  return value instanceof Secret
}
