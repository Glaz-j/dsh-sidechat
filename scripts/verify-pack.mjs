import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const directory = resolve('.pack-test')
const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'))
if (archives.length !== 1) {
  throw new Error(`expected one package archive, found ${archives.length}`)
}

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
if (manifest.name !== 'dsh-parallel-chat') {
  throw new Error(`unexpected npm package name: ${String(manifest.name)}`)
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('package manifest does not declare the DSH bundle patch')
}
if (manifest.dsh?.client !== undefined || manifest.exports?.['./client'] !== undefined) {
  throw new Error('package manifest still declares the removed custom Web client')
}
if (!manifest.peerDependencies?.['@deepseek-ai/dsh-subagent']) {
  throw new Error('package manifest does not declare the native subagent seam')
}
if (
  manifest.publishConfig?.access !== 'public'
  || manifest.publishConfig?.registry !== 'https://registry.npmjs.org/'
) {
  throw new Error('package manifest is not configured for public npm publication')
}
if (!manifest.files?.includes('README.md') || !manifest.files?.includes('README.zh.md')) {
  throw new Error('package archive does not declare both English and Chinese README files')
}

console.log(`[pack-check] ${archives[0]} declares the Host patch, native subagent dependency, bilingual docs, and public npm metadata`)
