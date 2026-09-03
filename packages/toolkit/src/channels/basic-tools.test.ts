/** 基础工具行的包解析契约：BASIC_TOOLS 引用的宿主包必须可被裸 Node 从本包解析。
 *  背景：link: 安装经 Junction realpath 到 checkout，动态 import 走标准 node_modules
 *  向上解析；tsx 源码模式有 tsconfig paths 兜底而生产模式没有，未声明即 ERR_MODULE_NOT_FOUND
 *  （2026-09-03 飞书 /new 处理失败事故根因）。 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { BASIC_TOOLS } from './basic-tools.ts'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))

/** BASIC_TOOLS 按平台互斥只含一个 shell 包；声明契约要对两个平台都成立。 */
const shellToolIds = ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-bash']
const requiredToolIds = [...new Set([...BASIC_TOOLS.map((t) => t.id), ...shellToolIds])]

function declaredDependencies(): Set<string> {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})])
}

describe('BASIC_TOOLS 包解析契约', () => {
  test('BASIC_TOOLS 引用的每个宿主包（含双平台 shell 包）都在 package.json 声明', () => {
    const declared = declaredDependencies()
    const missing = requiredToolIds.filter((id) => !declared.has(id))
    expect(missing, `未声明的宿主包（生产裸 Node 下动态 import 会 ERR_MODULE_NOT_FOUND）: ${missing.join(', ')}`).toEqual([])
  })

  test('裸 Node 子进程从本包真实解析全部宿主包（不复现 tsx 兜底）', () => {
    const probe = `probe-${randomBytes(6).toString('hex')}.mjs`
    const probePath = new URL(`../../${probe}`, import.meta.url)
    const script = `
      const results = {}
      for (const specifier of ${JSON.stringify(requiredToolIds)}) {
        results[specifier] = await import(specifier).then(() => 'OK', (error) => String(error.code ?? error))
      }
      console.log(JSON.stringify(results))
    `
    writeFileSync(probePath, script)
    try {
      const run = spawnSync(process.execPath, [fileURLToPath(probePath)], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 })
      expect(run.error, `子进程启动失败：${run.error}`).toBeUndefined()
      expect(run.status, `stderr: ${run.stderr}`).toBe(0)
      const results = JSON.parse(run.stdout) as Record<string, string>
      expect(results, '存在解析失败的宿主包').toEqual(Object.fromEntries(requiredToolIds.map((id) => [id, 'OK'])))
    } finally {
      rmSync(probePath, { force: true })
    }
  })
})
