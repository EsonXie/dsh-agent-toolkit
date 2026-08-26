/** prompt-stack 构建配置：纯 Node 半（lib/index.js，ESM + d.ts），无浏览器 bundle。 */
import type { UserConfig } from 'tsdown'

/** 所有包依赖保持 external，由安装侧（profile）解析；只转译本地 src。 */
const nodeConfig = {
  name: '@dsh-agent-toolkit/prompt-stack/node',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
} satisfies UserConfig

export default [nodeConfig]
