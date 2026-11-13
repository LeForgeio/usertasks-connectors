/** Shared parts of the build, test and package scripts. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as esbuild from 'esbuild'
import { checkModule, readManifest } from './checks.mjs'

/** The URL that the tests use. A package for this URL is refused. */
export const TEST_URL = 'https://api.example.test'

/** The one secret that every action declares. lib/rest.ts uses the same name. */
export const TOKEN_SECRET = 'api_token'

const VALUE_FLAGS = new Set(['url', 'sign'])
const SWITCH_FLAGS = new Set(['verbose'])

/** Read `<names...> [--url <url>] [--sign <pem>] [--verbose]` from the command line. */
export function parseArgs(argv = process.argv.slice(2)) {
  const names = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      names.push(argv[i])
      continue
    }
    const key = argv[i].slice(2)
    if (SWITCH_FLAGS.has(key)) flags[key] = true
    else if (VALUE_FLAGS.has(key)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`)
      flags[key] = value
      i++
    } else throw new Error(`Unknown flag --${key}. Known: ${[...VALUE_FLAGS, ...SWITCH_FLAGS].map((f) => `--${f}`).join(', ')}`)
  }
  const all = readdirSync('actions').filter((d) => existsSync(join('actions', d, 'spec.json')))
  for (const n of names) if (!all.includes(n)) throw new Error(`Unknown action "${n}". Known: ${all.join(', ')}`)
  return { names: names.length ? names : all, given: names, flags }
}

/** host or host:port of a URL, as the manifest lists it. */
export function hostOf(url) {
  const u = new URL(url)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${url}: use an http or https URL`)
  if (u.username || u.password) throw new Error(`${url}: do not put a user name or password in the URL; set the api_token secret`)
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error(`${url}: give the server root only, with no path, query or #`)
  return u.port ? `${u.hostname}:${u.port}` : u.hostname
}

/**
 * Build one action for one server URL into dist/<name>/: manifest.json with
 * that host, and action.js with that URL written in.
 */
export async function buildAction(name, url) {
  const dir = join('actions', name)
  const out = join('dist', name)
  mkdirSync(out, { recursive: true })
  const manifest = readManifest(join(dir, 'manifest.json'))
  manifest.capabilities.http.hosts = [hostOf(url)]
  const entry = manifest.entry ?? 'dist/action.js'
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const outfile = join(out, entry)
  const result = await esbuild.build({
    entryPoints: [join(dir, 'action.ts')],
    outfile,
    bundle: true, // the sandbox cannot load other files
    format: 'esm',
    splitting: false,
    platform: 'neutral', // the sandbox has no Node or browser built-ins
    target: 'es2020',
    minifySyntax: true,
    define: { __BASE_URL__: JSON.stringify(new URL(url).origin) },
    banner: { js: `/* ${manifest.key} ${manifest.version} - ${manifest.name} for ${url}. github.com/LeForgeio/usertasks-connectors (Apache-2.0). */` },
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  })
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    if (output.imports.length) throw new Error(`${file} still imports ${output.imports.map((i) => i.path).join(', ')}`)
  }
  const bytes = checkModule(readFileSync(outfile, 'utf8'), manifest)
  console.log(`${outfile}  ${(bytes / 1024).toFixed(1)} KB  ${manifest.key} ${manifest.version}  ${url}`)
  return { dir, out, manifest, entry }
}
