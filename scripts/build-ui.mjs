import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(rootDir, 'public', 'tsx')

await mkdir(outdir, { recursive: true })

await build({
  entryPoints: [
    path.join(rootDir, 'src', 'ui', 'editor.tsx'),
    path.join(rootDir, 'src', 'ui', 'tv-server.tsx')
  ],
  outdir,
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  jsx: 'automatic',
  sourcemap: false,
  minify: false,
  logLevel: 'info'
})
