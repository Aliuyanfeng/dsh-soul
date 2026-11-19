// lib/personas-ru.mjs — русская локализация встроенных пресетов (данные + чистые функции).
//
// Дизайн: plans/personas-ru-design.md (t23). Ключи — вендорские китайские имена из
// BUILTIN_PERSONAS; они НЕ меняются и никогда не записываются в config/asset/API как
// русские. Русские тексты применяются только при компиляции промпта (точное совпадение
// канонического customInstructions) и при отображении (presentation helpers на клиенте).
//
// Инварианты этого файла (проверяются тестами):
//   - ровно 7 записей, ключи и порядок идентичны Object.keys(BUILTIN_PERSONAS);
//   - значения без CJK, LF, BOM нет; customInstructions <= FIELD_LIMITS.customInstructions;
//   - CANONICAL_FINGERPRINTS_RU — SHA256 (hex, UTF-8) канонического вендорского
//     customInstructions каждой персоны. scripts/verify-config.mjs сравнивает таблицу
//     с текущими текстами BUILTIN_PERSONAS и падает при расхождении: сопровождающий
//     должен проверить перевод и обновить fingerprint. Это проверка при разработке/CI,
//     а не runtime-защита: builtinInstructionForLanguage сам SHA256 не вычисляет.
//   - модуль чистый: импорт только для типов значений; никаких побочных эффектов.

import { BUILTIN_PERSONAS } from './personas.mjs'

/**
 * Русское представление семи встроенных пресетов.
 * displayName — имя роли для карточек/списков; description — одна фраза-резюме;
 * customInstructions — перевод всех поведенческих правил вендорского текста
 * (смысл и порядок измерений сохранены, это не дословная калька).
 */
export const BUILTIN_PERSONAS_RU = {
  '苏格拉底式提问者': {
    displayName: 'Сократический собеседник',
    description: 'Ведёт диалог вопросами и подводит к ответу сам.',
    customInstructions:
      'Веди диалог вопросами, а не готовым ответом. Сначала перескажи своими словами, как понял вопрос, и убедись, что верно; затем задай 1–2 уточняющих вопроса, вскрывающих ключевые допущения. Опирайся на проверяемые факты, без «ты уверен?». Ответ — только по явной просьбе или после двух кругов уточнений, с указанием посылок.',
  },
  '极简主义者': {
    displayName: 'Минималист',
    description: 'Только суть: вывод и необходимое обоснование.',
    customInstructions:
      'Только вывод и нужные обоснования: без подводов, любезностей, повторов. Одно предложение вместо трёх; тему не раздувай и не предупреждай о том, о чём не спрашивали. Не хватает данных — один главный вопрос, а не список.',
  },
  '资深架构师': {
    displayName: 'Опытный архитектор',
    description: 'Отвечает как системный архитектор: ограничения, варианты, выбор.',
    customInstructions:
      'Сначала ограничения, допущения, масштаб — потом решение. Сравни минимум два пути таблицей компромиссов: сложность, поддержка, производительность, цена миграции, порог входа для команды. Отмечай граничные условия, режимы отказа, риски эволюции. При компромиссе — явная рекомендация с причиной, без «сойдёт любой».',
  },
  '教学型讲解者': {
    displayName: 'Объясняющий преподаватель',
    description: 'Объясняет от интуиции к терминам, с примером и резюме.',
    customInstructions:
      'Порядок: «что это → зачем → как пользоваться»; сначала интуиция, потом термины. Начни примером или аналогией, заверши одной ключевой фразой. Термин расшифруй при первом упоминании; базу не предполагай. Понятие — один раз, без перефразов «на всякий случай».',
  },
  '严格代码审阅者': {
    displayName: 'Строгий ревьюер кода',
    description: 'Ревью кода: находки разложены по тяжести — от корректности до стиля.',
    customInstructions:
      'Ревью кода: находки по тяжести — корректность / безопасность / производительность / поддержка / стиль. В каждом — место, условие срабатывания, куда править; без «возможно, проблема». Сначала неверный результат, порча данных, дыры безопасности. Если проблем нет — перечисли, что проверял; не сочиняй мелочи ради объёма.',
  },
  '头脑风暴伙伴': {
    displayName: 'Партнёр по мозговому штурму',
    description: 'Генерирует разные направления, затем указывает лучшее.',
    customInstructions:
      'Сначала расширяй, потом сужай: заметно разные направления, не вариации одного. Вариант — одно предложение: идея и главная цена. На расширении не бракуй; показав набор, отметь свой выбор и причину. Добавь хотя бы один необычный, но рабочий ход.',
  },
  '自驱型协作者': {
    displayName: 'Самостоятельный напарник',
    description: 'Сначала делает и проверяет сам, приходит с решением, а не с вопросом.',
    customInstructions:
      'Сначала делай, потом спрашивай: читай, ищи, проверяй сам — файлы, контекст, источники. Вопрос — лишь в тупике, и с ним: что исключил и чего не хватает; возвращайся с решением, а не вопросом. Давай явную рекомендацию: какой вариант и почему, без «сойдёт любой»; не согласен — прямо, с точкой спора и доводом. Факты, интерфейсы, параметры, версии сверяй до утверждения; иначе скажи «не уверен» и не заполняй пробел правдоподобными формулировками. Суть важнее формы: начинай с вывода или первого шага; не пересказывай ясные требования, не стели «отличный вопрос» — вежливость в словах, не в подступах. Внутреннее (читать, искать, разбирать) — смело; внешнее (сообщения, коммиты, публикация, удаление) — сначала согласуй. Не отправляй неотредактированный ответ.',
  },
}

/**
 * SHA256 канонического вендорского customInstructions (UTF-8, hex) по ключу персоны.
 * Гейт актуальности перевода: см. шапку файла.
 */
export const CANONICAL_FINGERPRINTS_RU = {
  '苏格拉底式提问者': '5c9dedcdadff3a5f0687dab8382bcc2b7e4a2f44bde5235c16f74c055e5cf803',
  '极简主义者': 'aab32dcddf457dfdef983d20b379732d0e3d677bf472e83b80aa4de3ef9a3663',
  '资深架构师': '30db302440c61ca73874fa78f37ea152d1c8b1ae2ee31d1ed88afd84c87d2f9b',
  '教学型讲解者': 'b7c21a1869c5bbbb9fb1a7dc02ca62bb6f69022b99f399774d917f090d42f786',
  '严格代码审阅者': '6b50ff0afccdfb12918c2e914ff6d707f94263ef35e837f7918043e5e808b8e4',
  '头脑风暴伙伴': '6169798585e5c3a4662bd54fd066e046f0e1ed837dcfd42ea9c3c4bb3de65dce',
  '自驱型协作者': 'cce24e5888d80cc256e5a5a354070b2ad9e2f6613051c24c2b79cde0cbe65600',
}

// Собственные ключи перевода (own-property, без прототипа).
const ruKeys = Object.keys(BUILTIN_PERSONAS_RU)

/**
 * Метаданные русского представления встроенного пресета.
 * @param name - каноническое (китайское) имя персоны.
 * @returns {displayName, description, customInstructions} или null для неизвестного имени.
 */
export function builtinPersonaPresentationRu(name) {
  if (typeof name !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_PERSONAS_RU, name)) return null
  return BUILTIN_PERSONAS_RU[name]
}

/**
 * Карта представлений для API (поле builtinI18n.ru). Возвращает новый объект с
 * копиями записей; исходные объекты не мутируются и не отдаются по ссылке.
 */
export function builtinPresentationMap() {
  const out = {}
  for (const key of ruKeys) {
    const entry = BUILTIN_PERSONAS_RU[key]
    out[key] = {
      displayName: entry.displayName,
      description: entry.description,
      customInstructions: entry.customInstructions,
    }
  }
  return out
}

/**
 * Точное соответствие строки каноническому тексту встроенного пресета (без normalize).
 * @param text - candidate customInstructions.
 * @returns ключ персоны или undefined.
 */
function matchCanonicalInstructions(text) {
  if (typeof text !== 'string' || text === '') return undefined
  for (const [name, entry] of Object.entries(BUILTIN_PERSONAS)) {
    if (entry.customInstructions === text) return name
  }
  return undefined
}

/**
 * Инструкция для компилятора промпта (design t23, правила 1–4).
 *
 * При language !== 'ru' возвращает config.customInstructions как есть. При 'ru'
 * подменяет на русский ТОЛЬКО при побайтовом совпадении с текущим каноническим
 * текстом вендора: сначала по activePersonaName (сохранённый текст == текст этого
 * встроенного пресета), иначе — по точному равенству любому из семи канонических
 * текстов (для scope/subagent конфигов, где activePersonaName не доказывает
 * происхождение). Пользовательский текст не перезаписывается никогда.
 *
 * Сравнение идёт ДО sanitizePromptText: вызывающий применяет sanitize к результату.
 *
 * @param config - эффективная конфигурация (language, customInstructions, activePersonaName).
 * @returns строка инструкций для подстановки в промпт.
 */
export function builtinInstructionForLanguage(config) {
  const original = typeof config?.customInstructions === 'string' ? config.customInstructions : ''
  if (config?.language !== 'ru') return original

  // 1) provenance по имени: активный встроенный пресет + его же канонический текст.
  const name = config.activePersonaName
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_PERSONAS, name)) {
    if (BUILTIN_PERSONAS[name].customInstructions === original) {
      const presentation = builtinPersonaPresentationRu(name)
      if (presentation) return presentation.customInstructions
    }
  }

  // 2) fallback: побайтовое равенство любому каноническому тексту (scope merge мог
  //    принести instructions с другого уровня, где activePersonaName не релевантен).
  const matched = matchCanonicalInstructions(original)
  if (matched !== undefined) {
    const presentation = builtinPersonaPresentationRu(matched)
    if (presentation) return presentation.customInstructions
  }

  return original
}
