/** 模型规则匹配：glob 编译、AND 打分、最高分选择。 */
import type { Rule, RuleMatch } from './types.ts'

/** 正则元字符（`*` 与 `?` 除外——它们是 glob 通配符，之后单独展开）。 */
const REGEXP_META = /[.+^${}()|[\]\\]/g

/**
 * 把 glob（`*` = 任意串，`?` = 单字符）编译为锚定全串的正则。
 * @param pattern - 非空 glob；空或全空白抛错（激活期响亮报错的调用点在 apply）。
 * @returns 锚定全串的正则。
 */
export function globToRegExp(pattern: string): RegExp {
  if (pattern.trim() === '') {
    throw new Error('prompt-stack: modelPattern must be a non-empty glob')
  }
  const source = pattern
    .replace(REGEXP_META, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${source}$`)
}

/**
 * 给一条规则的 match 打分：任一指定字段不匹配则整条不命中（返回 0）；
 * 命中分值为 model=4 / modelPattern=2 / provider=1 的累加。
 * @param match - 规则的匹配条件。
 * @param provider - 当前 agent 的 provider（创建期配置），可缺失。
 * @param model - 当前 agent 的模型 id，可缺失。
 * @returns 命中分值，0 表示不命中。
 */
export function scoreRule(match: RuleMatch, provider: string | undefined, model: string | undefined): number {
  let score = 0
  if (match.provider !== undefined) {
    if (match.provider !== provider) return 0
    score += 1
  }
  if (match.model !== undefined) {
    if (match.model !== model) return 0
    score += 4
  }
  if (match.modelPattern !== undefined) {
    if (model === undefined || !globToRegExp(match.modelPattern).test(model)) return 0
    score += 2
  }
  return score
}

/**
 * 选出唯一命中规则：最高分者，同分取配置序靠前者。
 * @param rules - 配置中的规则数组（顺序即优先级仲裁序）。
 * @param provider - 当前 agent 的 provider，可缺失。
 * @param model - 当前 agent 的模型 id，可缺失。
 * @returns 命中规则；无命中返回 undefined。
 */
export function selectRule(rules: readonly Rule[], provider: string | undefined, model: string | undefined): Rule | undefined {
  let best: Rule | undefined
  let bestScore = 0
  for (const rule of rules) {
    const score = scoreRule(rule.match, provider, model)
    if (score > bestScore) {
      best = rule
      bestScore = score
    }
  }
  return best
}
