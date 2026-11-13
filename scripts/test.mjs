/**
 * npm test -- [names...] [--verbose]
 * Builds each action for the test URL, then runs harness/run.ts on it in
 * the same QuickJS sandbox that UserTasks uses.
 */
import { spawnSync } from 'node:child_process'
import * as esbuild from 'esbuild'
import { TEST_URL, buildAction, parseArgs } from './common.mjs'

const { names, flags } = parseArgs()
await esbuild.build({
  entryPoints: ['harness/run.ts'],
  outfile: '.harness/run.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['quickjs-emscripten-core', '@jitl/quickjs-singlefile-cjs-release-sync'],
  logLevel: 'warning',
})
let failed = 0
for (const name of names) {
  const { dir, out } = await buildAction(name, TEST_URL)
  const args = ['.harness/run.mjs', out, dir, ...(flags.verbose ? ['--verbose'] : [])]
  const run = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (run.status !== 0) failed++
}
if (failed) {
  console.error(`\n${failed} action(s) failed`)
  process.exit(1)
}
