/**
 * Browser-artifact builder.
 *
 * DSH v0.1.5-rc.2 client bundles are classic scripts that self-register through
 * `window.__ModuleLoader__.load({ id, factory(require) })`. The factory is CJS:
 * externals resolve through its `require`, it defines `module`/`exports`, and it
 * returns `module.exports`. The wrapper below matches the official artifacts
 * shipped in the app verbatim in shape (single entry, no chunks, no CSS).
 */

import { build } from 'esbuild'

/** Exact registration id required by the DSH client module loader. */
export const CLIENT_ID = 'dsh-endeavour'

/** Browser entry point. */
export const CLIENT_ENTRY = 'src/client/index.ts'

/**
 * Bundle the browser entry into one classic script.
 * @returns the complete `window.__ModuleLoader__.load(...)` source.
 */
export async function buildClientCode(): Promise<string> {
  const result = await build({
    entryPoints: [CLIENT_ENTRY],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: [
      '@deepseek-ai/*',
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react-dom/client',
    ],
    logLevel: 'silent',
  })
  const cjs = result.outputFiles[0]?.text
  if (cjs === undefined) throw new Error('client build produced no output')
  const body = cjs
    .split('\n')
    .map((line) => (line === '' ? line : `\t\t${line}`))
    .join('\n')
  return [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(CLIENT_ID)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    body,
    '\t\treturn module.exports;',
    '\t},',
    '});',
    '',
  ].join('\n')
}
