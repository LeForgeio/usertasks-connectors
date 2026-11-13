/**
 * npm run build -- [names...] [--url <server URL>]
 * Builds into dist/<name>/. With no --url, the build is for the tests.
 */
import { TEST_URL, buildAction, parseArgs } from './common.mjs'

const { names, flags } = parseArgs()
for (const name of names) await buildAction(name, typeof flags.url === 'string' ? flags.url : TEST_URL)
