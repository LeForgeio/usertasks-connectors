/**
 * npm run package -- <name> --url <server URL> [--sign <ed25519 key.pem>]
 *
 * Tests the action, builds it for your server, and writes
 * release/<key>-<version>.zip to upload in UserTasks
 * (Extensibility > Workflow actions > Upload).
 *
 * With --sign, the zip also gets signature.json: an ed25519 signature over
 * the module's SHA-256 (hex). Make a key with
 * `openssl genpkey -algorithm ed25519 -out key.pem` and keep it out of git.
 */
import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZIP_BYTES } from './checks.mjs'
import { TEST_URL, buildAction, hostOf, parseArgs } from './common.mjs'
import { makeZip } from './zip.mjs'

const { given, flags } = parseArgs()
if (given.length !== 1) throw new Error('Give one action name: npm run package -- <name> --url <server URL>')
const name = given[0]
const spec = JSON.parse(readFileSync(join('actions', name, 'spec.json'), 'utf8'))
const url = typeof flags.url === 'string' ? flags.url : spec.default_url
if (!url) throw new Error(`${name} has no default server: give --url, for example --url ${spec.url_example ?? 'https://server.example.com'}`)
if (hostOf(url) === hostOf(TEST_URL)) throw new Error(`${url} is the test URL: give your real server URL`)

const test = spawnSync(process.execPath, ['scripts/test.mjs', name], { stdio: 'inherit' })
if (test.status !== 0) process.exit(test.status ?? 1)

const { out, manifest, entry } = await buildAction(name, url)
const code = readFileSync(join(out, entry))
const files = [
  { name: 'manifest.json', data: readFileSync(join(out, 'manifest.json')) },
  { name: entry, data: code },
  { name: 'README.md', data: readFileSync(join('actions', name, 'README.md')) },
]
const sha256 = createHash('sha256').update(code).digest('hex')
const keyPath = (typeof flags.sign === 'string' ? flags.sign : process.env.ACTION_SIGNING_KEY)?.replace(/^~(?=\/)/, homedir())
if (keyPath) {
  const privateKey = createPrivateKey(readFileSync(keyPath))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${keyPath} is not an ed25519 key`)
  const signature = {
    alg: 'ed25519',
    public_key: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'),
    signature: sign(null, Buffer.from(sha256, 'utf8'), privateKey).toString('base64'),
  }
  files.push({ name: 'signature.json', data: Buffer.from(`${JSON.stringify(signature, null, 2)}\n`) })
}
const zip = makeZip(files)
if (zip.length > ZIP_BYTES) throw new Error(`zip is ${zip.length} bytes; the limit is ${ZIP_BYTES}`)
mkdirSync('release', { recursive: true })
const file = join('release', `${manifest.key}-${manifest.version}.zip`)
writeFileSync(file, zip)
console.log(`\n${file}  ${(zip.length / 1024).toFixed(1)} KB  sha256 ${sha256.slice(0, 16)}...  for ${url}${keyPath ? '  signed' : ''}`)
console.log('Upload it in UserTasks: Extensibility > Workflow actions > Upload. Then approve the host and set api_token on the Access tab.')
