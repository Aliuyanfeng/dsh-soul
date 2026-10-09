# 快速开始

## 安装

```bash
dsh plugin --profile <profile> add dsh-soul
```

安装后需**完全重启 DSH 并刷新浏览器**，设置页才会出现「个性化」栏目。

## 配置

打开设置页 →「个性化」，或在会话里用 `/soul` 命令。可设置：

| 分组 | 配置项 |
| --- | --- |
| 总开关 | 启用 / 禁用个性化 |
| 关于你 | 昵称、职业、介绍（描述用户本人，不是你自己的身份） |
| 回复风格和语调 | 专业严谨 / 轻松自然 / 幽默风趣 / 吐槽达人 / 高效干练 |
| 特质 | 标题和列表、表情符号、表格（各：默认 / 增强 / 减弱）、回复长度（简洁 / 适中 / 详尽） |
| 输出语言 | 简体中文 / English（同时决定 `/soul` 命令的输出语言） |
| 自定义指令 | 补充角色、习惯等个性化要求 |
| 人设预设 | 7 个内置预设（随插件提供、不可删除）+ 保存当前配置为自己的预设（★ 标记当前匹配项） |
| Agent 工具 | `set_persona` 的确认模式开关 |
| 输入框光轨 | 开关、颜色（预设色板 / 取色器 / 十六进制）、流动速度、光带粗细 |

设置页底部还有**提示词预览**折叠区：表单无改动时显示当前生效的提示词；一旦有未保存的编辑，
就改为在保存前编译草稿、展示「保存后将生效的提示词」，未通过校验的字段会单独列出。

## 斜杠命令

```text
/soul show            查看当前配置（含送达状态）
/soul set k=v         修改配置项，如 /soul set style=humorous language=en
                      特质：headingLists=more emoji=less tables=more replyLength=concise
                      光轨：trailEnabled / trailColor / trailSpeed / trailWidth
/soul save <名>       保存当前配置为人设预设（内置名不可占用）
/soul use <名>        应用人设预设（内置预设同样可用）
/soul list            查看人设预设（✔ 当前匹配项；内置项带 [内置] 标记）
/soul del <名>        删除人设预设（别名 delete / rm；内置预设不可删）
/soul confirm         确认待生效的人设变更（确认模式）
/soul reject          拒绝待生效的人设变更
/soul reset           重置为默认值（保留人设预设库）
/soul enable          启用
/soul disable         禁用
/soul <昵称>          设置昵称（保留原始大小写）
```

## 配置文件

配置保存在 DSH 的用户数据目录：

```text
$DSH_HOME/soul-config.json
```

未设置 `DSH_HOME` 时使用 DSH 默认目录。同目录下可能出现的辅助文件：

- `soul-config.json.tmp` —— 原子写的中间态，正常会被 rename 吃掉，中断后才残留，可安全删除；
- `soul-config.json.corrupt` —— 配置损坏时的备份（也可能来自「重置」丢弃的损坏文件）。

配置损坏时插件会**如实上报**（设置页显示原因，普通保存会被拒绝以免覆盖你的配置），
此时设置页的**重置**是逃生口：它会把损坏文件另存为 `.corrupt` 再写入默认值。

## 生效时机与排查

保存后在**下一次请求**生效（配置变化同时走 system prompt section 与活动会话注入两条通道），
不会打断进行中的请求，也不改写历史消息。有效配置变化会在会话里留下一条
`[dsh-soul 个性化配置已更新]` 消息；纯外观配置（输入框光轨）只落盘，不产生该消息。

改了配置却不生效时，按顺序看：

1. `/soul show` 末尾的「送达」一行（是否有活动会话、注入是否成功）；
2. `GET /api/soul/status`（两条通道的状态、配置路径、错误原因）；
3. `npm run verify`（`npm run verify:strict` 会把「跳过」也视为失败）；
4. 详细排查见 `DEBUGGING.md`。
