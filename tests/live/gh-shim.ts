/**
 * A stand-in for the gh binary placed first on PATH during live runs: every call is logged and fails with SHIM_EXIT.
 * The shim goes only on the env object handed to the daemon (main()) or to product Commands; the harness gh.ts keeps
 * process.env.PATH, so harness calls never reach the shim. The log path is baked into the script because daemon
 * children inherit only PATH, HOME and LANG.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export const SHIM_EXIT = 97

export interface GhShim {
  dir: string
  bin: string
  log: string
  calls(): string[]
}

export function ghShim(root: string = tmpdir()): GhShim {
  const dir = mkdtempSync(join(root, 'gh-shim-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'calls.log')
  if (log.includes("'")) throw new Error('shim path has a quote')
  const script = join(bin, 'gh')
  writeFileSync(script, `#!/bin/sh\nprintf '%s %s\\n' "$$" "$*" >> '${log}'\nexit ${SHIM_EXIT}\n`)
  chmodSync(script, 0o755)
  return {
    dir,
    bin,
    log,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(line => line.length > 0)
        : [],
  }
}

export function daemonEnv(
  base: Readonly<Record<string, string | undefined>>,
  shim: GhShim,
): Record<string, string | undefined> {
  return { ...base, PATH: shim.bin + delimiter + (base.PATH ?? '') }
}
