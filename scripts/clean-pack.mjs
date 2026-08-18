import { rm } from 'node:fs/promises'

await rm('.pack-test', { recursive: true, force: true })
