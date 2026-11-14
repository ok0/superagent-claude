/** Preload for daemon child processes (NODE_OPTIONS=--import): replaces globalThis.fetch with the file-state fake GitHub named by ISSUECREW_TEST_GITHUB_STATE. */
import { STATE_ENV, fileGithubFetch } from './file-gh.ts'

const file = process.env[STATE_ENV]
if (file) globalThis.fetch = fileGithubFetch(file, globalThis.fetch.bind(globalThis))
