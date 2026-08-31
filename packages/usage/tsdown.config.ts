/** @dsh-agent-toolkit/token-usage 构建配置：Node 半（lib/index.js，ESM）+ client-module（lib/client-module.js，纯 ESM，供 toolkit bundle 复用）。 */
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** 必须等于 package.json 的 name：client-modules 扫描以包名为 entry id。 */
const ID = '@dsh-agent-toolkit/token-usage'

/** Node 半：所有包依赖保持 external，由安装侧（profile）解析；只转译本地 src。 */
const nodeConfig = {
  name: `${ID}/node`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'clsx', 'zod'],
  },
} satisfies UserConfig

/** 平台模块由 loader 模块表提供，保持 external（对照 dsh web/src/platform.ts + runtime 豁免）。 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form', '@deepseek-ai/dsh-client-runtime/client',
] as const
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

// Node 内建模块名（含 node: 前缀变体）：浏览器半命中即构建错误。
const NODE_BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
])

/** 浏览器半共用插件：纯净度门禁 + CSS Modules 内联（与 toolkit 同规则）。 */
const clientPlugins = [{
  // 纯净度门禁：跨插件值导入即构建错误；协作走 cordis 服务/slot。
  name: 'dsh-client-bundle-purity',
  resolveId(source: string) {
    if (NODE_BUILTINS.has(source)) {
      throw new Error(`client bundle purity: "${source}" 是 Node 内建模块——浏览器半禁止引入`)
    }
    if (!source.startsWith('@deepseek-ai/')) return null
    if ((CLIENT_EXTERNALS as readonly string[]).includes(source)) return null
    if (VENDORED_LIBRARY.test(source)) return null
    if (INLINE_SAFE.test(source)) return null
    throw new Error(`client bundle purity: "${source}" 不是平台模块或 inline-safe 线层——禁止跨插件值导入`)
  },
}, {
  // CSS Modules 内联：x.module.css → 哈希类名映射 + <style data-plugin> 自动注入。
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(this: { addWatchFile(id: string): void }, virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
      'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
      '  const tag = document.createElement(\'style\');',
      `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}]

/** client-module：纯 ESM，无 loader 包装，供 dsh-agent-toolkit 浏览器半 alwaysBundle 内联。 */
const clientModuleConfig = {
  name: `${ID}/client-module`,
  entry: { 'client-module': 'src/client/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => ((CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: clientPlugins,
} satisfies UserConfig

/** 浏览器半：lazy-CJS factory，由 dsh client-modules 装载（bundle URL /plugins/<id>/client.js）。 */
const clientConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => ((CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: clientPlugins,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig

export default [nodeConfig, clientModuleConfig, clientConfig]
