// 人设插画里与 IO 无关的纯函数：格式判定、文件名映射、上限。
//
// 为什么单独成模块：这段代码决定「什么文件能落盘」，必须有**真实字节**的测试。
// 埋在本体里就只能对它做静态断言（读源码正则），而 magic bytes 判定恰恰是
// 静态断言覆盖不到的地方 —— 一个字节写错，测试还是绿的。

import { createHash } from 'node:crypto'

// 只收这三种位图。**刻意不收 SVG**：SVG 可以内嵌脚本与外部引用，而这张图除了
// <img> 还可能被导出、被第三方查看器打开 —— 那是我们控制不了的渲染环境。
export const USER_ART_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

// 单张上限 1.5MB：够 1024×1024 的 PNG，又不至于把配置目录变成图床。
export const MAX_ART_BYTES = 1.5 * 1024 * 1024
// base64 比原图大 ~33%，再留一点余量给 JSON 外壳。
export const MAX_ART_BODY_BYTES = 3 * 1024 * 1024

// 预设名 → 文件名。名字可以是中文 / 空格 / 任意字符，不能直接拼路径；
// sha1 前 16 位既稳定又不可能穿越。改名 = 新预设（图不跟随），
// 这与「保存为新预设」的语义一致。
export function artKeyOf(name) {
  return createHash('sha1').update(String(name), 'utf8').digest('hex').slice(0, 16)
}

// 按文件头判断真实格式。扩展名和 Content-Type 都是客户端说的，不可信。
export function sniffImageMime(buf) {
  if (!buf || typeof buf.length !== 'number') return null
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp'
  return null
}
