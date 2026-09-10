import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // ui-primitives is a link: devDep whose built lib keeps react/react-dom
    // external, resolving them to deepseek-harness's own node_modules copies.
    // Dedupe to the package's single React instance so component specs mounting
    // ui-primitives primitives never load a second copy (hooks would break).
    dedupe: ['react', 'react-dom'],
  },
  test: {
    css: {
      // entry.spec 断言窄栏按钮带 rail class，需把本包 src 下的 *.module.css
      // 处理成真类名（non-scoped：导出的类名即本地名，如 css.rail === 'rail'）。
      // 收窄 include：宿主 ui-primitives bundle 顶层 import 的 25 个 *.module.css
      // 含 :where(ul, ol) 等选择器，若全量注入 jsdom 会致 getByRole 抛
      // SyntaxError: '*+:where(ul, ol))' is not a valid selector（同 usage 侧修复）。
      include: [/packages[\\/]toolkit[\\/]src[\\/].*\.module\.css$/],
      modules: { classNameStrategy: 'non-scoped' },
    },
  },
})
