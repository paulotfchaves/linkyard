// Credentials and failures for the hosted installer.
//
// Two rules live here, and every other module in this service depends on both.
//
// A token is never a string. It arrives wrapped in `Secret` — the class the rest
// of the product already uses — and the only place the real value appears is the
// single `.reveal()` that builds an Authorization header. Re-exported rather
// than reimplemented so there is one class to audit, not two.
//
// A failure is never upstream text. Railway and Cloudflare embed the request in
// their error objects, and an HTTP client's thrown error carries the headers it
// sent; `JSON.stringify(body.errors)` is how a token reaches a log file. So a
// failure is a code from the frozen catalogue below and nothing else. Upstream
// bodies may be *inspected* to pick the code, and are then dropped.

import { Secret, isSecret } from '../../core/secret.mjs'

export { Secret, isSecret }

// The closed enum. A code that is not here cannot be reported, which is what
// makes "the installer never shows upstream text" checkable rather than hoped.
export const FAILURE = Object.freeze({
  INPUT_INVALID: 'input_invalid',
  TURNSTILE_FAILED: 'turnstile_failed',
  TOO_MANY_JOBS: 'too_many_jobs',
  JOB_NOT_FOUND: 'job_not_found',

  RAILWAY_TOKEN_INVALID: 'railway_token_invalid',
  RAILWAY_TOKEN_NOT_ACCOUNT: 'railway_token_not_account',
  RAILWAY_TOKEN_NOT_FOUND: 'railway_token_not_found',
  RAILWAY_TOKEN_AMBIGUOUS: 'railway_token_ambiguous',
  RAILWAY_WORKSPACE_MISSING: 'railway_workspace_missing',
  RAILWAY_RATE_LIMITED: 'railway_rate_limited',
  RAILWAY_UNREACHABLE: 'railway_unreachable',
  RAILWAY_API_FAILED: 'railway_api_failed',
  RAILWAY_DEPLOY_FAILED: 'railway_deploy_failed',
  RAILWAY_DOMAIN_RECORDS_MISSING: 'railway_domain_records_missing',

  CLOUDFLARE_TOKEN_INVALID: 'cloudflare_token_invalid',
  CLOUDFLARE_TOKEN_UNSCOPED: 'cloudflare_token_unscoped',
  CLOUDFLARE_TOKEN_NO_TTL: 'cloudflare_token_no_ttl',
  CLOUDFLARE_ZONE_NOT_FOUND: 'cloudflare_zone_not_found',
  CLOUDFLARE_UNREACHABLE: 'cloudflare_unreachable',
  CLOUDFLARE_API_FAILED: 'cloudflare_api_failed',

  DNS_NAME_FORBIDDEN: 'dns_name_forbidden',
  DNS_RECORD_EXISTS: 'dns_record_exists',

  CERTIFICATE_TIMEOUT: 'certificate_timeout',
  ADMIN_CREATE_FAILED: 'admin_create_failed',
  INTERNAL: 'internal',
})

const CODES = new Set(Object.values(FAILURE))

export function isFailureCode(code) {
  return CODES.has(code)
}

/**
 * A failure the installer is allowed to talk about.
 *
 * `context` exists for the manual-cleanup list and for naming the record that
 * blocked a create — values the installer itself produced. It is guarded rather
 * than documented: a Secret or a non-primitive slipping in here is the exact
 * accident this class exists to prevent, so it throws instead of redacting.
 */
export class ProvisionError extends Error {
  constructor(code, context = {}) {
    if (!isFailureCode(code)) throw new TypeError(`unknown failure code: ${String(code)}`)
    for (const [key, value] of Object.entries(context)) {
      if (isSecret(value)) throw new TypeError(`failure context "${key}" holds a Secret`)
      const kind = typeof value
      if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
        throw new TypeError(`failure context "${key}" must be a primitive`)
      }
    }
    super(code)
    this.name = 'ProvisionError'
    this.code = code
    this.context = Object.freeze({ ...context })
  }

  toJSON() {
    return { code: this.code, context: this.context }
  }
}

/**
 * Every escape hatch funnels through here.
 *
 * An unexpected throw — a TypeError in our own code, a fetch that rejected with
 * the request attached — becomes `internal`. Anything else would let a stack
 * trace that quotes the request body reach the browser.
 */
export function asProvisionError(error) {
  return error instanceof ProvisionError ? error : new ProvisionError(FAILURE.INTERNAL)
}
