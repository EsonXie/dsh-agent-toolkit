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
      // entry.spec 断言窄栏按钮带 rail class，需把 *.module.css 处理成真类名
      // （non-scoped：导出的类名即本地名，如 css.rail === 'rail'）。
      include: [/\.module\.css$/],
      modules: { classNameStrategy: 'non-scoped' },
    },
  },
})
