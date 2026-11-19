import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createVSIX } from '@vscode/vsce'
import JSZip from 'jszip'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const build = join(root, 'build')
const packagePath = join(build, `${manifest.name}-${manifest.version}.vsix`)
await mkdir(build, { recursive: true })
await createVSIX({ cwd: root, packagePath, dependencies: false })

// 检查实际归档，而不是只检查构建目录或 VSCE 的待打包清单。
const zip = await JSZip.loadAsync(await readFile(packagePath))
const files = Object.values(zip.files)
  .filter((entry) => !entry.dir)
  .map((entry) => entry.name)
assert.deepEqual(
  files.sort(),
  [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/LICENSE.txt',
    'extension/readme.md',
    'extension/dist/extension.js',
    'extension/language-configuration.json',
    'extension/package.json',
    'extension/syntaxes/jq.tmLanguage.json'
  ].sort()
)
console.log(`Verified VSIX contents: ${packagePath}`)
