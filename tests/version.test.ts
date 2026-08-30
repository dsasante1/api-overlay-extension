import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// manifest.json is the version Chrome installs and the popup shows; package.json
// is what npm prints in every build log. They drifted apart once already, so a
// bump to one without the other fails here.

const read = (rel: string) => JSON.parse(readFileSync(resolve(__dirname, '..', rel), 'utf8')) as { version: string }

describe('version', () => {
  it('is the same in manifest.json and package.json', () => {
    expect(read('package.json').version).toBe(read('manifest.json').version)
  })

  it('is the same in package-lock.json', () => {
    expect(read('package-lock.json').version).toBe(read('manifest.json').version)
  })
})
