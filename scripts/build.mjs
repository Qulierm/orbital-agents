/** Build the host face with tsc and the browser face with esbuild. */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('lib', { recursive: true, force: true })
mkdirSync('lib/prompts', { recursive: true })

execFileSync('node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.host.json'], { stdio: 'inherit' })

cpSync('src/prompts/endeavour.md', 'lib/prompts/endeavour.md')
cpSync('src/prompts/builder.md', 'lib/prompts/builder.md')

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'info',
})

console.log('build: host (tsc) + browser (esbuild) complete')
