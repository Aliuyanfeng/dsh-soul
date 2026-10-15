# 变更审计与回滚（0.8.0 设计草案）

## 1. 目标

任何一次配置写入都留下一条不可篡改的记录，用户可以在设置页看到「谁在什么时候改了什么」，
并把活动配置恢复到历史中的任意一个状态。

非目标：不做预设库的版本管理（见 §4.3），不做多用户审计，不做远程上报。

## 2. 为什么值得做

现状有三个具体缺口，不是「用户体验优化」而是「数据可恢复性」：

1. **配置被改坏了没有退路。** `set_persona` 工具、`soulConfig.updateConfig` 服务、
   `/soul set`、设置页保存 —— 四条写路径都能整体改写配置，而用户只能靠
   `soul-config.json` 的手动备份。
2. **「为什么变成这样了」无法回答。** 配置是扁平对象、上一次写入的值就地被覆盖，
   没有任何地方留旧值。用户看到 `style: humorous` 时无法区分「我两周前改的」
   与「刚才某个 Agent 调工具改的」。
3. **已有一次真实事故的教训。** 「应用预设后点保存，人设被打回默认」这个 bug 的
   排查耗时很长，根本原因是**中间状态不可观测** —— 如果有审计，
   一次 `GET /api/soul/history` 就能看到 `style` 在两条记录之间来回跳。

## 3. 埋点位置：唯一漏斗

`index.mjs:383` 的 `commitConfig(mutate)` 是**全部**配置写路径的收敛点。
grep 实测 14 个调用点（不含定义与注释），全部经过它：

| 行 | 来源 (`source`/`action`) |
| --- | --- |
| `index.mjs:429` | `rollback`（`@reset`，`resetConfigWithEscape` 内部） |
| `index.mjs:690` | `web` / `save`（HTTP `POST /api/soul/config`） |
| `index.mjs:934` | `persona` / `use`（`applyPersonaEntry` 内部） |
| `index.mjs:1000` | `web` / `savePreset` |
| `index.mjs:1079` | `web` / `deletePreset` |
| `index.mjs:1386` | `command` / `nickname` |
| `index.mjs:1439` | `command` / `enable` |
| `index.mjs:1445` | `command` / `disable` |
| `index.mjs:1456` | `command` / `savePreset` |
| `index.mjs:1520` | `command` / `deletePreset` |
| `index.mjs:1558` | `command` / `set` |
| `index.mjs:1567` | `command` / `confirm` |
| `index.mjs:1927` | `tool` / `set_persona` |
| `index.mjs:1973` | `service` / `update` |

两个间接调用者必须把来源**穿透**下去：`resetConfigWithEscape()`（`index.mjs:423`，
三个调用点 `index.mjs:803` / `:1430` / `:1985`）与 `applyPersonaEntry()`（`index.mjs:931`，
两个调用点 `index.mjs:1038` / `:1474`）。

⇒ **`commitConfig` 必须加第二个参数**：`commitConfig(mutate, source)`。

## 4. 数据模型

### 4.1 存储位置

`$DSH_HOME/soul-config.history.jsonl` —— 配置文件的兄弟文件，路径由
`historyPathFor(configPath())` 推导（把尾部的 `.json` 换成 `.history.jsonl`）。

选 JSONL 而不是 JSON 数组的三个理由：

1. **追加是 O(1)。** 每写一次配置就追加一行，不需要读回整个历史再重写。
2. **崩溃安全。** 进程在追加中途被杀，最坏情况是最后一行截断；其余行完好。
   读侧丢弃「解析不了的行」，历史自然收敛到最后一个完整状态。
3. **天然审计语义。** 追加-only 的文件，人能直接用文本工具读，也能用
   `git diff` 之类的工具链处理。

### 4.2 条目结构

```json
{
  "v": 1,
  "id": "lq3k9z2a-4f1b2c",
  "at": "2026-02-14T09:31:07.123Z",
  "source": "web",
  "action": "save",
  "fields": ["style", "emoji"],
  "before": { "style": "professional", "emoji": "default" },
  "after":  { "style": "humorous",     "emoji": "more"    },
  "personas": { "added": [], "removed": [] }
}
```

- `id` = `Date.now().toString(36)` + `-` + 6 个随机十六进制字符。`at` 的毫秒精度不足以保证
  唯一（写队列串行但两次写入可以落在同一毫秒），所以需要独立的 id。
- `before` / `after` 只装**发生变化的字段**，不是完整配置快照。理由：一次 `style` 改动
  不该在磁盘上留下 4.8 KB；而回滚需要的「改成什么」本来就是逐字段的。
- `fields` 是 `Object.keys(before)` 的冗余记录。留着是为了让**人**读 JSONL 时不必
  自己 diff 两个对象 —— 审计文件的第一读者是排障的人，不是程序。
- `personas` 记录预设库的增删（见 §4.3），无变化时为 `{ added: [], removed: [] }`。

### 4.3 预设库只记事件，不做快照

`index.mjs:399` 的 `diffKeys` 里有 `if (key === 'personas') continue` —— 预设库的增删
**不进 `changed`**，因此也不会自动进审计。这是刻意设计（预设库不是活动配置、
不影响提示词），审计必须显式处理，否则「新增了一个预设」会静默漏记。

处理方式：记录事件，不记录内容。

- `personas.added`: `["实验性重构"]`
- `personas.removed`: `[{ "name": "旧的", "entry": { "style": "casual", "emoji": "more" } }]`

`removed` 带条目内容，因为**删除是唯一不可逆的操作** —— 新增一个预设后悔了可以再删，
删掉一个预设后悔了没有任何出路。这是唯一一处值得存内容的例外，成本可忽略
（单个预设几百字节）。

**整表回滚不恢复预设库，但删除可以单独撤销。** 分开处理的理由：

- 「恢复活动配置到那一刻」语义清晰；「把预设库恢复到那一刻」语义不明 ——
  要不要删掉之后新建的？要不要顺带恢复期间删掉的？对**集合**做时间旅行没有唯一解。
- 而「撤销这一次删除」语义唯一且用户确实需要。所以删除事件的条目上给一个
  「恢复此预设」按钮，恢复一个命名条目，不动其它任何东西。
- 与 `defaultConfigPreservingPersonas`（`index.mjs:406`）「重置不清空预设」的既有
  取舍一致：预设是资产，重组资产的动作永远由用户单点发起。

### 4.4 回滚的语义：恢复**目标条目之后的状态**

回滚 = 把目标条目的 `after` 应用到当前活动配置。等价于「回到那次改动刚做完的样子」。

不采用「撤销这一条」（`before`）作为默认动作：两者在最后一条上等价，但在中间条目上，
「恢复到这个状态」才是用户从列表里点一个历史点时的心智模型。

值一律过 `sanitizeConfig` 白名单后再合并：审计文件是**不可信输入**（用户可手改、
可被其它工具写坏），绝不 `{ ...current, ...entry.after }` 直接展开。

## 5. 追加时机与失败处理

追加发生在 `commitConfig` 的**队列任务内、`saveConfig` 成功之后**：

```
loadConfig → mutate → diffKeys → saveConfig → appendHistory
```

- 在队列内 ⇒ 追加与写入天然串行，不需要第二次加锁。
- 在 `saveConfig` 之后 ⇒ 只有真正落盘的变更才有记录（写失败的提交不留假记录）。
- **追加失败不让提交失败**：审计是次级设施，一次磁盘满不该让用户连设置都存不了。
  失败记进模块级 `lastHistoryFailure`，由 `GET /api/soul/history` 的 `warning` 字段
  回传给 UI —— 不静默、也不阻塞。

## 6. 容量与压实

- `MAX_ENTRIES = 200`（行数上限）。
- 追加前先 `stat` 文件大小；超过 `MAX_BYTES = 512 * 1024` 时才读取全文、保留最新
  `MAX_ENTRIES` 条、原子重写（临时文件 + rename，同 `writeConfigFile`）。
- 幸福路径只有一次 `stat`，压实是低频操作。

## 7. HTTP 契约

三条路由，**一律先校验 `req.method`**
（教训：`/api/soul/config/reset` 曾完全没有方法校验，任何方法包括 GET 都会执行破坏性写入）。

| 路由 | 方法 | 请求 | 响应 |
| --- | --- | --- | --- |
| `/api/soul/history` | GET | — | `{ ok, entries: [...最新在前...], warning? }` |
| `/api/soul/history/rollback` | POST | `{ id }` | `{ ok, config, changed, skipped, entry }` |
| `/api/soul/history/restore-persona` | POST | `{ id }` | `{ ok, ...personaLibrary }` |
| `/api/soul/history/clear` | POST | — | `{ ok, removed }` |

- `rollback` 找不到 `id` ⇒ 400（而不是静默成功）。
- `rollback` 的 `skipped` 列出「审计里有、但当前校验不通过」的字段名（沿用
  `applyPersonaEntry` 的「部分应用 + 明示」约定）。
- `restore-persona` 只接受 `personas.removed` 非空的条目，且**逐个**走
  `sanitizePersonaName` + 内置名拒绝 + 同名已存在时拒绝（不静默覆盖用户后来新建的同名预设）。
- 回滚与恢复预设都走 `commitConfig`（带上 `source: 'rollback'` / `'restorePersona'`），
  于是**每一个回滚动作自己也留下一条记录** —— 审计天然形成链条，
  「我恢复过、然后又改回去」在列表里看得见。
- `entries` 在服务端就按时间倒序返回，客户端不再排序（只排一次，且两边排序规则必然漂移）。

## 8. 安全与边界

- **历史文件当不可信输入。** 逐行校验：`v` 必须是 1、`id`/`at` 是非空字符串、
  `source` 在白名单内、`before`/`after` 只接受已知配置键且值类型匹配。
  非法行丢弃并计入 `dropped`（不抛错 —— 一条坏行不该让整个页面打不开）。
- **拒绝原型污染键。** `__proto__` / `constructor` / `prototype` 一律丢弃
  （复用 `lib/config.mjs:105` 的 `FORBIDDEN_PERSONA_NAMES` 思路）。
- **内容绝不进提示词。** 审计记录不参与 `compilePrompt`，与「绑定内容不进提示词」同理。
- **长度上限。** 单行超过 `MAX_LINE_BYTES = 64 * 1024` 直接丢弃；读取总行数上限
  `MAX_READ_LINES = 1000`（防手写一个 10 万行的文件把内存吃满）。
- **时间戳不参与任何逻辑判定。** `at` 只用于显示；排序与定位都用文件内的物理顺序 + `id`。

## 9. 影响的文件

| 文件 | 改动 |
| --- | --- |
| `lib/history.mjs` | **新增**。路径推导 / 条目构造与校验 / JSONL 解析 / 压实（纯函数，可独立测试） |
| `index.mjs` | `commitConfig(mutate, source)`；14 个调用点补来源；两个间接调用者穿透；追加与压实；四条路由 |
| `client/index.mjs` | 新增「变更记录」分组（第 5 组，排在「Agent 工具」之后）；回滚 / 恢复预设 / 清空的二次确认；文案键 |
| `scripts/verify-history.mjs` | **新增**。`lib/history.mjs` 的纯函数断言组 |
| `scripts/verify-store.mjs` | 新增「配置写入留下审计」的真实文件系统断言（追加的原子性、压实重写） |
| `scripts/verify-config.mjs` | 来源标注（14 处调用点各自带对）与「提交即留痕」断言 |
| `scripts/verify-client.mjs` | 分组渲染、倒序、二次确认、回滚请求体断言 |
| `package.json` | `verify` 链加入 `verify-history`；版本号 0.7.2 → 0.8.0 |

## 10. 分层与实施顺序

每一步可独立验证、独立提交。

| 步 | 内容 | 验证 |
| --- | --- | --- |
| 0.8.0-a | `lib/history.mjs` 纯函数层 | `verify-history`（含坏行、超长行、原型污染、压实边界） |
| 0.8.0-b | `commitConfig` 加来源 + 追加 + 两个间接调用者穿透 | `verify-config` 的来源标注断言 + 真实提交探针 |
| 0.8.0-c | 四条 HTTP 路由（含方法校验、`skipped`、`restore-persona`） | 真实路由探针（含 405、非法 id、手改历史文件） |
| 0.8.0-d | 设置页「变更记录」分组 | `verify-client`（渲染 / 倒序 / 二次确认 / 请求体） |

## 11. 已知风险

1. **审计文件与配置文件的原子性不共享。** 配置写入成功、追加失败时，两者会短暂不一致。
   缓解：失败有回传（§5），且截断容忍（§4.1）保证不一致只会「少一条记录」，不会让
   历史文件不可读。
2. **历史会泄露用户写过的内容。** 用户可能改过一段不想留痕的 `customInstructions`。
   缓解：「清空记录」是一等操作，且审计文件与配置同目录、同样在 `$DSH_HOME` 下，
   不引入新的泄露面。
3. **回滚不是万能的。** 只恢复活动配置的 16 个字段，预设库不回滚（§4.3）。
   缓解：UI 上明确写「恢复人设配置，不影响人设预设库」。
4. **200 条上限会滚动丢弃最老的记录。** 缓解：上限是常量、UI 显示「最多保留 200 条」。
5. **「恢复此预设」可能撞上同名条目。** 用户删了 A，之后又新建了一个同名的 A，
   此时点旧记录的「恢复」会静默覆盖新版。缓解：同名已存在时**拒绝**并给出文案，
   不静默覆盖（覆盖是不可逆的，而拒绝只是让用户自己先改名）。
6. **审计只覆盖 `commitConfig` 这条路。** 手改配置文件、别的插件直接写同一个文件，
   都不留痕。这不是缺陷而是边界（§12）—— 假称覆盖了全部改动比不覆盖更危险。

## 12. 明确不做

- **不做预设库的整表快照与回滚**（§4.3）。删除的单点撤销是例外，且有单独的语义与按钮。
- **不做审计的导出 / 导入**：想要的人可以直接拷 `soul-config.history.jsonl`。
- **不做文件变更监听与外部改动审计**：只记录经由 `commitConfig` 的写入。
  手改 `soul-config.json` 不留痕 —— 那属于「fs 层的事」，本插件没有义务也没有能力覆盖。
- **不做「谁改的」到 Agent 身份级的归因**：工具调用记录 `source: 'tool'`，
  不细分到具体会话 / 消息 id（会话 id 会随子代理变化，归因不可靠且泄露面更大）。
- **不做定时清理 / 自动过期**：只按条数压实，不按时间删。
- **不做配置的版本分支 / 命名快照**：那是「预设」已有的职责，两套东西会打架。

## 13. 附录：客户端 UI 细节（设置页第 5 组）

分组标题「变更记录」/「Change history」，排在「Agent 工具」（`client/index.mjs:2300`）
之后，是最后一组。走既有手风琴（`openSection === 'history'`）。

三块内容：

1. **顶部一行状态**：「最近 N 条 · 最多保留 200 条」，右侧一个「清空记录」文字钮
   （内联二次确认：armed 态 + 5s 超时，与删除预设同一套，**不用原生 `confirm`**）。
2. **记录列表**（最多渲染 20 条，其余折叠为「还有 N 条」）。
   每行：相对时间 · 来源徽标 · 字段名列表。展开后逐字段显示 `旧值 → 新值`。
3. **行尾操作**：每条记录一个「恢复」文字钮（纯文字样式，`color: var(--dsw-alias-state-error-primary)`
   留给破坏性动作），`personas.removed` 非空的记录额外给一个「恢复此预设」。

数据取自 `GET /api/soul/history`。分组展开时才拉取（与「人设预设」同款懒加载），
回滚 / 恢复 / 清空后重新拉取并重置 armed 态。

文案键（zh / en 各一份）：

| 键 | zh |
| --- | --- |
| `group.history` | 变更记录 |
| `history.empty` | 还没有任何变更记录。 |
| `history.summary` | 最近 {count} 条 · 最多保留 {max} 条 |
| `history.more` | 还有 {count} 条 |
| `history.clear` | 清空记录 |
| `history.clearArmed` | 确认清空？ |
| `history.restore` | 恢复 |
| `history.restoreArmed` | 确认恢复？ |
| `history.restoreDone` | 已恢复到该记录。 |
| `history.restorePreset` | 恢复此预设 |
| `history.restorePresetDone` | 已恢复预设「{name}」。 |
| `history.warning` | 记录可能不完整：{reason} |
| `history.footer` | 恢复人设配置，不影响人设预设库。 |

来源徽标文案：`web` 网页保存 / `command` 斜杠命令 / `tool` Agent 工具 /
`service` 插件调用 / `persona` 应用预设 / `rollback` 回滚 / `restorePersona` 恢复预设。

## 14. 判断力探针（每个行为改动都要配一批）

断言通过不等于断言有效。以下每一条都写成一个**能制造真实故障的变异**
（在临时副本上改坏源码，期望至少一条断言变红），照既有做法落在一个 shell 驱动里，
带控制组先行 / `trap` 兜底 / `mktemp` 不删三条防呆。

| # | 变异 | 期望变红的断言 |
| --- | --- | --- |
| 1 | `commitConfig` 里把 `appendHistory` 挪到 `saveConfig` **之前** | 「配置写失败时不得留下审计条目」 |
| 2 | 删掉 `diffKeys` 里的 `personas` 跳过判断 | 「仅预设变更必须出现在时间线上」（这是核心陷阱） |
| 3 | 追加失败时把异常向上抛（而不是只记 `lastHistoryFailure`） | 「审计写失败配置仍成功」 |
| 4 | 回滚时 `{ ...current, ...entry.after }` 直接展开（不过 `sanitizeConfig`） | 「审计文件里的非法值不得写入配置」 |
| 5 | 回滚走 `entry.before` 而不是 `entry.after` | 「恢复到目标条目之后的状态」 |
| 6 | 删掉历史文件的坏行过滤 | 「一条坏行不得让整个列表打不开」 |
| 7 | 删掉「同名预设已存在则拒绝」 | 「恢复预设不得静默覆盖同名条目」 |
| 8 | `rollback` 路由删掉 `req.method` 校验 | 「GET `/rollback` 必须 405」（对照 `config/reset` 的既有教训） |
| 9 | 把 `source` 参数默认成一个固定值（丢掉 14 处标注） | 「每个调用点各自的来源必须落在条目里」 |
| 10 | 压实阈值改成永久不触发 | 「超过上限时必须压实」 |
