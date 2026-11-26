// scripts/verify-art.mjs — 人设插画上传的离线回归（npm run verify:art）
//
// 重点不是「路由能不能通」，而是**什么文件能落盘**：
//   ① 文件头判定（magic bytes）—— 扩展名与 Content-Type 都是客户端说的，不可信；
//   ② 文件名映射 —— 预设名可以是中文，不能直接拼路径；
//   ③ 路由策略 —— 内置预设的插画不可覆盖、用户图不长期缓存、删除要过 CSRF。
//
// 判定逻辑在 lib/persona-art.mjs（纯函数），所以这里能喂真实字节；
// 路由策略只能读源码断言 —— 起真 HTTP 需要完整宿主，收益不值。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAX_ART_BODY_BYTES,
  MAX_ART_BYTES,
  USER_ART_EXT,
  artKeyOf,
  sniffImageMime
} from '../lib/persona-art.mjs'
import { assertCount } from './lib/skip-report.mjs'

const EXPECTED_ASSERTIONS = 14
let passed = 0

function check(name, fn) {
  try {
    fn()
  } catch (error) {
    error.message = `【${name}】${error.message}`
    throw error
  }
  passed++
  console.log(`  ✓ ${name}`)
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ', 'ascii')])

console.log('插画格式判定（真实字节）')

check('PNG 文件头 → image/png', () => {
  assert.equal(sniffImageMime(PNG), 'image/png')
})

check('JPEG 文件头 → image/jpeg', () => {
  assert.equal(sniffImageMime(JPEG), 'image/jpeg')
})

check('WebP（RIFF + WEBP）→ image/webp', () => {
  assert.equal(sniffImageMime(WEBP), 'image/webp')
})

check('SVG / HTML / 纯文本一律拒绝', () => {
  for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<!doctype html>', 'hello']) {
    assert.equal(sniffImageMime(Buffer.from(text, 'utf8')), null, `不得接受：${text.slice(0, 20)}`)
  }
})

check('长度不足的字节流不算图片（不做越界读取）', () => {
  assert.equal(sniffImageMime(Buffer.from([0x89])), null)
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8])), null)
  assert.equal(sniffImageMime(Buffer.alloc(0)), null)
  assert.equal(sniffImageMime(null), null)
})

check('判据只看字节，与扩展名无关（RIFF 但不是 WEBP 也拒绝）', () => {
  const riffWav = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt ', 'ascii')])
  assert.equal(sniffImageMime(riffWav), null)
})

console.log('文件名映射')

check('同名稳定、不同名不同值，且只含十六进制字符', () => {
  const a = artKeyOf('我的助手')
  assert.equal(a, artKeyOf('我的助手'))
  assert.notEqual(a, artKeyOf('我的助手2'))
  assert.match(a, /^[0-9a-f]{16}$/)
})

check('文件名不可能包含路径分隔符或 ..', () => {
  for (const name of ['../../etc/passwd', 'a/b\\c', '..']) {
    assert.match(artKeyOf(name), /^[0-9a-f]{16}$/, `名字 ${name} 必须映射成纯 hex`)
  }
})

console.log('上限与格式白名单')

check('单张上限 1.5MB，请求体上限留给 base64 余量', () => {
  assert.equal(MAX_ART_BYTES, 1.5 * 1024 * 1024)
  assert.ok(MAX_ART_BODY_BYTES > MAX_ART_BYTES, 'base64 比原图大，请求体上限必须更高')
})

check('只允许 PNG / JPEG / WebP 三种扩展名（不含 svg）', () => {
  assert.deepEqual(Object.values(USER_ART_EXT).sort(), ['.jpg', '.png', '.webp'])
  assert.equal(Object.values(USER_ART_EXT).includes('.svg'), false)
})

console.log('路由策略（源码）')

const source = readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8')

check('上传走 readJsonBody 并放宽到插画上限', () => {
  assert.match(source, /readJsonBody\(req, MAX_ART_BODY_BYTES\)/, '上传必须用插画的请求体上限（默认 64KB 装不下 1MB 图）')
})

check('内置预设的插画不可覆盖', () => {
  assert.match(source, /if \(isBuiltinPersona\(presetName\)\)/, '缺少内置预设保护')
})

check('用户图不长期缓存，包内图可长期缓存', () => {
  assert.match(source, /art\.user \? 'no-store' : 'public, max-age=86400'/, '缓存策略应区分用户图与包内图')
})

check('用户图优先于包内图', () => {
  const idx = source.indexOf('function resolvePersonaArt')
  const chunk = source.slice(idx, idx + 600)
  const userAt = chunk.indexOf('resolveUserArt(name)')
  const builtinAt = chunk.indexOf('personaArtDir()')
  assert.ok(userAt >= 0 && userAt < builtinAt, 'resolvePersonaArt 必须先查用户图')
})

if (!assertCount('verify-art', passed, EXPECTED_ASSERTIONS)) process.exit(1)
console.log(`\n全部通过：${passed} 项检查`)
