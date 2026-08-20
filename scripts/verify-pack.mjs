import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const directory = resolve('.pack-test')
const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'))
if (archives.length !== 1) {
  throw new Error(`expected one package archive, found ${archives.length}`)
}

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('package manifest does not declare the DSH bundle patch')
}
if (manifest.dsh?.client !== undefined || manifest.exports?.['./client'] !== undefined) {
  throw new Error('package manifest still declares the removed custom Web client')
}
if (!manifest.peerDependencies?.['@deepseek-ai/dsh-subagent']) {
  throw new Error('package manifest does not declare the native subagent seam')
}

console.log(`[pack-check] ${archives[0]} declares the Host patch and native subagent dependency`)
