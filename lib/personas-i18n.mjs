// lib/personas-i18n.mjs — 内置人设本地化的通用引擎（纯函数，无副作用）
//
// 为什么要有这一层：每个语种的「名称 / 简介 / 指令」是数据，但**怎么用**是同一套规则
// （见 lib/personas-ru.mjs 文件头的不变量）。以前这套规则只有 ru 一份，复制第二份就等于
// 让「精确匹配才替换」「键永远是规范名」这些约定出现两个可能走偏的实现；抽到这里之后，
// 新增语种只是再加一张数据表。
//
// 规则（与 personas-ru.mjs 设计 t23 一致，语种无关）：
//   1) 只有 `language === <本语种>` 时才可能替换，其余语言原样返回用户文本；
//   2) 替换的前提是**逐字节**等于当前内置文本：先是 activePersonaName 指向的内置项，
//      再退化为「等于任意一条内置文本」（作用域合并后 activePersonaName 未必可信）；
//   3) 用户改写过的指令永远不会被替换；
//   4) 键（内含中文名）只用于查表，从不出现在 config / audit / URL 里。
//
// 比较发生在调用方 sanitize 之前 —— 与既有的 ru 实现一致。

import { BUILTIN_PERSONAS } from './personas.mjs'

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

/**
 * 用一张语种数据表造出该语种的三个查询函数。
 *
 * @param {object} options
 * @param {string} options.language - 该表对应的输出语言代码（'ru' / 'ja' …）。
 * @param {object} options.table    - 键必须与 BUILTIN_PERSONAS 一致；每条含
 *                                    displayName / description / customInstructions。
 * @returns {{language: string, keys: string[], presentationOf: Function,
 *            presentationMap: Function, instructionFor: Function}}
 */
export function createPersonaLocalizer({ language, table }) {
  if (typeof language !== 'string' || language === '') {
    throw new Error('createPersonaLocalizer: language is required')
  }
  if (!table || typeof table !== 'object') {
    throw new Error('createPersonaLocalizer: table is required')
  }
  const keys = Object.keys(table)

  // 元数据查询：返回表内条目本身（只读用途），未知名字给 null。
  function presentationOf(name) {
    if (typeof name !== 'string') return null
    if (!hasOwn(table, name)) return null
    return table[name]
  }

  // 给 API 的地图（builtinI18n.<language>）。返回新对象 + 新条目副本，
  // 调用方拿到的东西改不坏数据表，也拿不到表内引用。
  function presentationMap() {
    const out = {}
    for (const key of keys) {
      const entry = table[key]
      out[key] = {
        displayName: entry.displayName,
        description: entry.description,
        customInstructions: entry.customInstructions
      }
    }
    return out
  }

  // 逐字节等于某条内置文本 → 返回该内置项的规范键（不做 normalize）。
  function matchCanonicalInstructions(text) {
    if (typeof text !== 'string' || text === '') return undefined
    for (const [name, entry] of Object.entries(BUILTIN_PERSONAS)) {
      if (entry.customInstructions === text) return name
    }
    return undefined
  }

  /**
   * 提示词编译器拿到的指令文本。
   * 非本语种、非内置文本、或用户改写过的文本，一律原样返回。
   */
  function instructionFor(config) {
    const original = typeof config?.customInstructions === 'string' ? config.customInstructions : ''
    if (config?.language !== language) return original

    // 1) provenance 按名字：当前正是这个内置预设，且磁盘上的文本没被改过。
    const name = config.activePersonaName
    if (typeof name === 'string' && hasOwn(BUILTIN_PERSONAS, name)) {
      if (BUILTIN_PERSONAS[name].customInstructions === original) {
        const presentation = presentationOf(name)
        if (presentation) return presentation.customInstructions
      }
    }

    // 2) 兜底：等于任意一条规范文本（作用域合并可能带来别的层级的指令，
    //    那里的 activePersonaName 不能证明出处）。
    const matched = matchCanonicalInstructions(original)
    if (matched !== undefined) {
      const presentation = presentationOf(matched)
      if (presentation) return presentation.customInstructions
    }

    return original
  }

  return { language, keys, presentationOf, presentationMap, instructionFor }
}
