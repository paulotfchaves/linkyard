#!/usr/bin/env node

// `npx linkyard install` — the Docker Compose path, for any Linux VPS.
//
// The hosted setup panel covers Railway. This covers the other half of the
// promise: a machine you already own, no account with anybody, one command.

import { createInterface } from 'node:readline/promises'
import { stdin, stdout, argv, exit } from 'node:process'
import { access, writeFile, chmod } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInstall, composeEnv } from './env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(args) {
  const out = { _: [] }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const [flag, inline] = arg.slice(2).split('=')
    if (inline !== undefined) out[flag] = inline
    else if (args[i + 1] && !args[i + 1].startsWith('--')) out[flag] = args[(i += 1)]
    else out[flag] = true
  }
  return out
}

const USAGE = `linkyard install — write the .env a Docker Compose install runs on

  npx linkyard install [options]

  --panel-host <host>       where the panel answers      (panel.example.com)
  --redirect-apex <host>    the domain short links live under (example.com)
  --email <address>         for the TLS certificate
  --cloudflare-token <tok>  optional; can be added in the panel later
  --out <path>              defaults to ./.env
  --force                   overwrite an existing file
  --yes                     fail on a missing answer instead of prompting

Every secret is generated here. Nothing is sent anywhere: this command talks to
no network, and the file it writes stays on this machine.
`

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function collect(flags) {
  const answers = {
    panelHost: flags['panel-host'],
    redirectApex: flags['redirect-apex'],
    acmeEmail: flags.email,
    cloudflareToken: flags['cloudflare-token'] ?? '',
  }

  const missing = ['panelHost', 'redirectApex', 'acmeEmail'].filter((key) => !answers[key])
  if (missing.length === 0) return answers

  // --yes means unattended, and an unattended run must fail loudly rather than
  // block forever on a prompt nobody is there to answer.
  if (flags.yes || !stdin.isTTY) {
    throw new Error(`missing required options: ${missing.join(', ')}`)
  }

  const rl = createInterface({ input: stdin, output: stdout })
  try {
    if (!answers.panelHost) answers.panelHost = await rl.question('Panel host (panel.example.com): ')
    if (!answers.redirectApex) answers.redirectApex = await rl.question('Redirect domain (example.com): ')
    if (!answers.acmeEmail) answers.acmeEmail = await rl.question('Email for the TLS certificate: ')
    if (!answers.cloudflareToken) {
      answers.cloudflareToken = await rl.question('Cloudflare API token (blank to add later): ')
    }
  } finally {
    rl.close()
  }
  return answers
}

async function install(flags) {
  const target = resolve(String(flags.out ?? '.env'))

  // Checked before anything is generated: overwriting this file with fresh
  // secrets orphans every Cloudflare token already encrypted with the old key,
  // and no error message afterwards can undo that.
  if ((await exists(target)) && !flags.force) {
    throw new Error(
      `${target} already exists. Overwriting it replaces ENCRYPTION_KEY, which makes every credential already stored unreadable. Pass --force only if that is what you want.`
    )
  }

  const values = buildInstall(await collect(flags))

  await writeFile(target, composeEnv(values), { mode: 0o600 })
  await chmod(target, 0o600)

  stdout.write(`\nWrote ${target} (owner-readable only).\n\n`)
  stdout.write('Next:\n')
  stdout.write(`  1. Point DNS at this machine:\n`)
  stdout.write(`       A  ${values.LINKYARD_PANEL_HOST}  -> this server's IP\n`)
  stdout.write(`       A  *.${values.LINKYARD_REDIRECT_APEX}  -> this server's IP\n`)
  stdout.write('  2. docker compose up -d\n')
  stdout.write(`  3. Open https://${values.LINKYARD_PANEL_HOST}/setup and use this token once:\n`)
  stdout.write(`       ${values.SETUP_TOKEN}\n\n`)
  stdout.write('Back up that .env. The key in it is the only way to read the\n')
  stdout.write('credentials the panel stores; losing it means re-entering every one.\n')
}

const flags = parseArgs(argv.slice(2))
const command = flags._[0] ?? (flags.help ? 'help' : '')

try {
  if (command === 'install') await install(flags)
  else if (command === 'help' || command === '') stdout.write(USAGE)
  else {
    stdout.write(`unknown command: ${command}\n\n${USAGE}`)
    exit(2)
  }
} catch (err) {
  // The message, never a stack: the reader is an operator on a fresh VPS, and
  // the useful part is which answer to change.
  stdout.write(`\nlinkyard: ${err?.message ?? err}\n`)
  exit(1)
}
