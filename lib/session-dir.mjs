/**
 * 会话目录名 ↔ 工作区路径。
 *
 * DSH 把每个会话存在 `$DSH_HOME/sessions/<编码后的目录>/<会话 id>/` 下，
 * 目录名是**路径的转义形式**。Soul 的总览页要按「最近活跃」排序工作区，
 * 而活跃时间只能从会话文件的 mtime 拿 —— 所以必须把目录与工作区对上。
 *
 * ── 关键：为什么是「正向编码」而不是「反向解码」 ──
 *
 * 编码规则（从真实样本归纳）：
 *   1. 整体被 `--` 包住；
 *   2. 路径分隔符 `\` `/` 都写成 `-`；
 *   3. 非 ASCII 字符写成 `~XXXX~`（UTF-16 码元的 4 位大写十六进制）。
 *
 * 规则 2 是**有损**的：`D:\my-project` 与 `D:\my\project` 编码后都是
 * `--D-my-project--`。所以**反向解码永远猜不准**（实测：`dsh-plugin` 会被
 * 解成 `dsh\plugin`）。
 *
 * 但正向是**无歧义**的：给定工作区路径，能算出唯一正确的目录名。
 * 因此匹配一律走「把工作区路径编码，再与目录名精确比较」——
 * 不去解析目录名，就不会猜错。`decodeSessionDirName` 仅用于诊断展示，
 * 且明确标注可能失真。
 */

/**
 * 把一个 UTF-16 码元写成 `~XXXX`（**尾部不带 ~**）。
 *
 * 真实样本核对：`THE LAST DAYLIGHT` → `THE~0020LAST~0020DAYLIGHT`，
 * 即转义段是「~ + 4 位十六进制」，紧随其后就是下一个字符。
 * 写成 `~0020~` 会编出 `THE~0020~LAST` —— 与磁盘上的名字对不上。
 */
function encodeUnit(code) {
  return '~' + code.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * 工作区路径 → 会话目录名（**无歧义，匹配时用这个方向**）。
 * @param {string} winPath 如 `D:\AliuProject\dsh-plugin`
 * @returns {string|null} 如 `--D-AliuProject-dsh-plugin--`
 */
export function encodeSessionDirName(winPath) {
  if (typeof winPath !== 'string' || winPath.trim() === '') return null
  // 分隔符（两种）与盘符冒号都 → '-'，并去掉首尾多余的
  // 例：D:\AliuProject\dsh-plugin → D-AliuProject-dsh-plugin
  //     （冒号也必须吃掉，否则会编出 --D:-AliuProject-- 这种对不上的名字）
  const normalized = winPath.trim().replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '')
  if (normalized === '') return null
  let body = ''
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i)
    // 可见 ASCII（0x21–0x7E）原样保留；其余一律 ~XXXX~
    // —— 空格必须转义（真实样本：THE LAST DAYLIGHT → THE~0020LAST~0020DAYLIGHT）
    if (code >= 0x21 && code <= 0x7e) body += normalized[i]
    else body += encodeUnit(code)
  }
  return '--' + body + '--'
}

/**
 * 解码一个 `~XXXX~` 段；不是合法 BMP 码点则返回 null。
 */
function decodeUnit(hex) {
  if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null
  const code = Number.parseInt(hex, 16)
  // 代理区单独出现不是合法字符
  if (code >= 0xd800 && code <= 0xdfff) return null
  return String.fromCharCode(code)
}

/**
 * 会话目录名 → 路径（**仅供诊断展示**）。
 *
 * ⚠️ 有损：`-` 无法区分「分隔符」与「原本的连字符」。`--D-a-b--` 既可能是
 * `D:\a-b` 也可能是 `D:\a\b`。返回值里的 `lossy` 恒为 true 就是在提醒这件事。
 * **绝不要用它的结果去匹配工作区** —— 用 `encodeSessionDirName` 做正向比较。
 *
 * @returns {{ path: string|null, lossy: boolean, reason: string|null }}
 */
export function decodeSessionDirName(dirName) {
  if (typeof dirName !== 'string' || dirName === '') {
    return { path: null, lossy: false, reason: '目录名为空' }
  }
  if (!dirName.startsWith('--') || !dirName.endsWith('--') || dirName.length <= 4) {
    return { path: null, lossy: false, reason: '不是 --…-- 形式' }
  }
  const body = dirName.slice(2, -2)
  if (body === '') return { path: null, lossy: false, reason: '目录名为空' }

  let text = ''
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '~') {
      // 转义段：**~ + 4 位十六进制**，长度恒为 5，后面直接接下一位。
      //
      // ⚠️ 绝不能写成 /~([0-9A-Fa-f]{4})~?/ —— 连续转义时（~591A~5F15~64CE）
      // 那个可选的尾随 ~ 会把**下一段的引导 ~** 吃掉，于是 5F15 被当成字面量，
      // 「多引擎」解成「多5F15擎」。实测真实目录名踩到过这个坑。
      const m = /^~([0-9A-Fa-f]{4})/.exec(body.slice(i))
      if (!m) return { path: null, lossy: true, reason: '含无法解码的 ~XXXX~ 转义' }
      const decoded = decodeUnit(m[1])
      if (decoded === null) {
        return { path: null, lossy: true, reason: '含无法解码的 ~XXXX~ 转义' }
      }
      text += decoded
      i += m[0].length
      continue
    }
    text += ch
    i++
  }

  const parts = text.split('-').filter((seg) => seg !== '')
  if (parts.length === 0) return { path: null, lossy: true, reason: '没有路径段' }

  const first = parts[0]
  // 盘符：单个字母
  const path = /^[A-Za-z]$/.test(first)
    ? `${first.toUpperCase()}:\\${parts.slice(1).join('\\')}`
    : parts.join('\\')
  // 恒为有损：无法区分连字符与分隔符
  return { path, lossy: true, reason: null }
}

/**
 * 把「目录名 → 工作区」配对：**正向编码 + 精确比较**。
 *
 * @param {string[]} dirNames 磁盘上的会话目录名
 * @param {string[]} workspacePaths 工作区注册表给出的路径
 * @returns {Map<string, string>} 目录名 → 工作区路径（未匹配上的目录不出现在结果里）
 */
export function matchSessionDirsToWorkspaces(dirNames, workspacePaths) {
  const out = new Map()
  if (!Array.isArray(dirNames) || !Array.isArray(workspacePaths)) return out
  // 工作区路径 → 期望目录名（同一目录名可能来自多个等价路径，取第一个即可）
  const byDir = new Map()
  for (const p of workspacePaths) {
    const dir = encodeSessionDirName(p)
    if (dir !== null && !byDir.has(dir)) byDir.set(dir, p)
  }
  for (const dir of dirNames) {
    const hit = byDir.get(dir)
    if (hit !== undefined) out.set(dir, hit)
  }
  return out
}

/**
 * 比较键：Windows 路径大小写不敏感、分隔符两种都认。
 * 只用于比较，不用于显示。
 */
export function pathCompareKey(p) {
  if (typeof p !== 'string' || p === '') return ''
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}
