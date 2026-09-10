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
      // entry.spec 断言窄栏按钮带 rail class，需把本包 src 下 *.module.css 处理成真类名
      // （non-scoped：导出的类名即本地名，如 css.rail === 'rail'）。
      // 只处理本包 src：宿主包 ui-primitives 的 bundle 在顶层 import 其全部 *.module.css
      // （含 markdown/MarkdownText.module.css 的 :where(ul, ol) 等括号内带逗号选择器），
      // 若一并注入，jsdom 的 nwsapi 无法解析，getByRole → getComputedStyle 会抛 SyntaxError。
      include: [/packages[\\/]usage[\\/]src[\\/].*\.module\.css$/],
      modules: { classNameStrategy: 'non-scoped' },
    },
  },
})
