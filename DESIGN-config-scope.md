# 三级配置作用域（0.9.0 设计草案）

> 状态：**设计阶段**。本文件取代 `DESIGN-persona-scope.md` 的 §7（UI 形态）与交付计划，
> 但**继承**它的 §1–§6（目标、取舍、路径规范化）与 `lib/bindings.mjs` 全部实现。
>
> 前置事实（均已在本机 DSH 运行时核实，不是推测）：
> - `workspaceRegistry` 是**宿主侧**服务：`super(ctx, "workspaceRegistry")`，插件可 `ctx.get()`；
> - 它有 `list()` / `get(id)` / `resolveByPath(path)`，内部维护 `headers` / `sessionPaths` 索引；
> - **`agent.id` 就是 `sessionId`**（`typeCtx.typert.lookups.register("agent", { wire: "agentId", wireTypeSymbol: ".../SessionId" })`）；
> - `agents.list()` 是 **live registry**，会话关闭即消失 ⇒ **不能**用作「会话是否已删除」的证据；
> - `sessionPersistence.list()` 扫磁盘会话文件 ⇒ **这才是**权威清单；
> - `systemPrompt.section.text(assembly)` 是**同步**调用，路径内不能有任何 `await`。

## 1. 三层各管什么

| 层 | 管什么 | 存在哪 | 谁改它 |
| --- | --- | --- | --- |
| **Global** | 长期稳定的默认人格（昵称、风格、特质、语言、自定义指令） | `soul-config.json` | 设置页 |
| **Workspace** | 项目特定的人格偏好。键是**宿主的工作区**，不是目录字符串 | `soul-config.json` 的 `workspaces` 字段 | 设置页「工作区」分组 |
| **Session** | 当前对话的临时覆盖 | `soul-sessions/{hash}.json`（sidecar） | 会话内命令 / 详情页 |

**合并规则**：字段级**部分覆盖**，`Global ← Workspace ← Session`，靠后的只覆盖它**显式声明过**的字段。

这条规则复用既有语义：`/api/soul/personas/use` 与 `configForCwd` 都是这么做的。用户在设置页点「使用」一个预设看到的效果，必须与该目录里自动拿到的**逐字段一致** —— 否则「绑定生效了吗」无法用任何已有操作验证。

**`enabled` 例外**：它是全局总开关，**任何作用域都不能覆盖它**。已有的实现是 `compilePrompt()` 首行 `if (!config.enabled) return ''`，只要合并时不让下层改这个字段，就天然满足「全局 enabled 统一控制所有作用域」。

## 2. 身份：workspaceId 优先，cwd 回退

### 2.1 解析链

```
Session 覆盖（若有）
    ↓
workspaceId（来自 sessionId → workspaceId 索引）
    ↓ 索引未命中
cwd 最长前缀匹配（lib/bindings.mjs 既有能力）
    ↓ 未命中
Global
```

### 2.2 索引怎么建

装配路径是**同步**的，所以索引必须在装配路径**之外**建好：

```js
// 装配层：存储一份不可变快照
let sessionWorkspaceIndex = new Map()   // Map<string sessionId, string workspaceId>

function rebuildWorkspaceIndex(registry) {
  const next = new Map()
  for (const ws of registry.list()) {
    for (const sid of ws.sessionIds) next.set(String(sid), String(ws.id))
  }
  sessionWorkspaceIndex = next
}

// section.text —— 同步、只读快照、不做 I/O
text: (assembly) => {
  const sessionId = assembly?.agent?.id
  const workspaceId = sessionId === undefined ? undefined : sessionWorkspaceIndex.get(String(sessionId))
  return compilePrompt(resolveScopedConfig(workspaceId, cwdOfAgent(assembly?.agent)).config)
}
```

**重建时机**（三条，缺一不可）：

1. `ctx.on('domain/changed', ...)` —— 宿主工作区变更的主通道；
2. **装配时未命中且 `registry` 可见**时，标记一次「待重扫」，下一轮任务重建（不在装配里重建）；
3. 装配完成后延迟一拍的首轮重建（服务刚就绪时索引为空）。

> 第 2 条是兜底：`domain/changed` 的事件名是宿主内部约定，若它改名，索引会静默停止更新。
> 兜底让「索引陈旧」退化为「多扫一次」，而不是「永远命中不到」。

### 2.3 为什么保留 cwd 回退

**`workspaceId` 是纯客户端状态。** `dsh-api-workspace-controller` 的服务面在 client 侧，服务端装配时拿不到它，只能拿到 `session.header.cwd`。因此：

- 索引命中 ⇒ 用工作区配置（**稳定身份**，目录改名/移动不影响）；
- 索引未命中 ⇒ 回退 cwd 前缀匹配（**行为退化到 0.8.1 的语义，不是更糟**）；
- 都没有 ⇒ Global。

**失败方向安全**是这条设计的硬要求：任何一环不可用，都只能在「更精确」与「更宽松」之间移动，不能变成「错误的人设」。

### 2.4 cwd 不等于工作区（必须在 UI 上说清）

`workspaceRegistry.resolveByPath()` 内部用 `realpathNormalize`，所以**路径别名、符号链接、大小写**由宿主解决 —— 这比裸字符串比较可靠得多。

但它仍**不等于** `workspaceId`：同一目录可能对应多个工作区实例（工作区被删后重建）。所以：

- 界面上凡是「按目录匹配」得出的结论，标注来源为**目录**；
- 凡是「按工作区」得出的结论，标注为**工作区**；
- 两者并存时，工作区优先。

## 3. 配置快照一致性（0.9.0-a）

### 3.1 现在的隐患

```js
// index.mjs —— 每次装配都读模块级可变对象
const base = configCache || DEFAULT_CONFIG
return compilePrompt(configForCwd(base, cwdOfAgent(...)).config)
```

`configCache` 由写队列整体替换。若一次装配过程中间发生写入，同一轮里 section 可能求值两次、拿到**两个版本**。症状与「System Prompt Updated 已出现、模型却仍用旧昵称」同类。

### 3.2 做法

给配置加**单调修订号**，装配时把用到的修订号记进诊断状态：

```js
let configRevision = 0            // 每次 commitConfig 成功 +1

function snapshotConfig() {
  return { revision: configRevision, value: configCache }
}

// section.text：整个装配只取一次快照
text: (assembly) => {
  const snap = snapshotConfig()
  deliveryState.lastAssembledRevision = snap.revision   // 诊断用
  return compilePrompt(resolveScopedConfig(...snap.value...).config)
}
```

**不做的事**：不引入锁、不做「装配期间禁止写入」。装配是纯读，写入走队列；只要有单调修订号，事后能回答「进模型的是哪一版」，这就够了。

## 4. Session 覆盖的存储

### 4.1 布局

```
$DSH_HOME/
├── soul-config.json          # Global + workspaces
├── soul-config.history.jsonl # 变更记录（0.8.0）
├── soul-bindings.json        # 0.8.1 遗留，0.9.0 迁移后废弃
└── soul-sessions/            # ← 新增，与配置**同级**
    ├── 3f2a….json
    └── 9c1b….json
```

**不引入 `index.json`。** 理由：`{sessionId}.json` 里已经有 `updatedAt`，扫描目录即可得到全部信息；加索引只会新增「索引与文件不一致」这一故障类别，而这个项目刚因「两处手工同步的清单」（`FIELD_KEYS`）踩过坑。

### 4.2 文件形状

```jsonc
{
  "schemaVersion": 1,
  "sessionId": "sess_x9",        // 必须与文件内容里的 id 一致（防错配）
  "overrides": { "style": "humorous", "replyLength": "concise" },
  "createdAt": "2026-10-19T06:00:00Z",
  "updatedAt": "2026-10-19T06:30:00Z",
  "orphan": {                     // 缺失 = 从未被标记
    "firstSeenAt": "2026-10-19T06:00:00Z",
    "lastScannedAt": "2026-10-19T06:00:00Z"
  }
}
```

**文件名 = `sha256(sessionId)` 前 32 位 + `.json`。** 哈希而不是转义：转义规则要随文件系统变，哈希定长且无歧义。文件内的 `sessionId` 与文件名必须可互相校验。

### 4.3 写入

直接复用 `lib/store.mjs` 的 `writeConfigFile`（临时文件 + rename 原子替换）。

**并发**：每个 `sessionId` 一把 Promise 链（`Map<sessionId, Promise>`），写前用 `updatedAt` 做乐观校验——不等就拒绝并让调用方重试。不引入全局锁（不同 session 互不影响）。

**损坏**：解析失败 / `schemaVersion` 不认识 / `sessionId` 不匹配 ⇒ **隔离该文件**（改名 `.bad`），记日志，**绝不静默覆盖成默认配置**。

## 5. 回收：保守三阶段 + 双入口

### 5.1 判定依据

**唯一可信证据是 `sessionPersistence.list()`**（扫磁盘）：

```js
const persistence = ctx.get('sessionPersistence')
if (persistence === undefined) return          // 服务不可用 ⇒ 本轮不判定
const stored = new Set((await persistence.list()).map((s) => String(s.id)))
```

**绝不使用 `agents.list()`** —— 它是 live registry，会话切走就会消失。用它判定会误删正在使用的覆盖。

### 5.2 三阶段

| 阶段 | 条件 | 动作 |
| --- | --- | --- |
| 1 发现候选 | `sessionId ∉ stored` **且** 本轮 `list()` 成功返回 | 在文件内写 `orphan.firstSeenAt`（已存在则不覆盖） |
| 2 宽限期 | `firstSeenAt` 距今 ≥ **30 天** | 仍不删；期间若该 id 重新出现 ⇒ **删除 `orphan` 字段**（撤销候选） |
| 3 回收 | 上述全部满足 **且** 本轮扫描完整成功 | 才允许删除 |

**双条件的关键**：只有时间条件不够。如果这台机器 30 天里持久化层一直不可用，时间到了也不该删 —— 否则「30 天」只度量了「我们多久没检查」。

### 5.3 两个入口（可同时存在）

1. **命令**：`/soul sessions gc [--dry-run]` —— 列出候选、宽限期剩余、本轮可回收项。
2. **设置页按钮**：插件详情页的「会话覆盖」区块内，展示候选数量并可一键清理（同样先展示清单）。

**第一版只 dry-run**：`--apply` 需要显式传入，且执行前打印将删除的完整清单。

### 5.4 位置约束（硬要求）

清理**绝不在装配路径里**。装配是同步、纯读、每轮都跑；清理是异步、有副作用、低频。两者混在一起的后果是「一次普通请求顺便删了用户配置」。

## 6. UI 形态

### 6.1 工作区「平铺卡片」，不用下拉

宿主 `WorkspaceView` 有 `title` 与 `path`，一个段落里能同时表达**名字**和**绑定态**；下拉关闭时只能显示一项，用户必须展开才知道有哪些工作区。

```
我的工作区                        3 个 · 1 个已绑定

  ┌────────────────────────────────────────────┐
  │ dsh-plugin                    ✓ 苏格拉底式提问者 │
  │ D:\AliuProject\dsh-plugin                    │
  └────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ dsh-soul                              ＋ 绑定 │
  │ D:\AliuProject\dsh-soul                      │
  └────────────────────────────────────────────┘

其它目录（未纳入工作区的路径）
  [ 手动输入路径…                          ] [绑定]
```

点卡片时在卡片内展开人设胶囊（不是弹层、不是下拉），一次点击完成绑定，比「先选工作区再选人设」少一步。

### 6.2 当前会话

设置页槽位是 `root` scope，**拿不到 sessionId**（已核实）。所以「当前会话」必须由宿主遍历 `agents.list()` 算好，经 `/api/soul/bindings` 返回 —— 这条 0.8.1 已经实现，直接复用。

### 6.3 Session 覆盖的可见性

会话有覆盖时必须**常驻可见**（输入框附近一行 `本次会话：教学模式 [恢复]`）。否则用户会以为「我改的是全局设置」，下次开新会话发现没生效。

## 7. 迁移

| 来源 | 目标 | 规则 |
| --- | --- | --- |
| `soul-bindings.json`（0.8.1 遗留） | `soul-config.json` 的 `workspaces` | 首启一次性迁移：按 `path` 创建/复用工作区；**没有任何用户持有它**（特性从未发布），实际为 no-op，但要写成幂等迁移以防内部构建 |
| 无 | `soul-sessions/` | 目录不存在即视为「无覆盖」，不报错 |

## 8. 验收

| 层 | 断言组 | 守什么 |
| --- | --- | --- |
| 纯函数 | `verify-scope.mjs`（新增） | 三层合并的字段级覆盖、`enabled` 不可被覆盖、`schemaVersion` 处理、哈希文件名、损坏隔离 |
| 宿主侧 | `verify-e2e-prompt.mjs` 扩展 | workspaceId 命中 / cwd 回退 / 都未命中；`persistence` 不可用时不判定 |
| 回收 | `verify-sessions-gc.mjs`（新增） | 三阶段状态机、宽限期撤销、**`agents.list()` 消失但磁盘仍在 ⇒ 不得标记** |
| 客户端 | `verify-client.mjs` 扩展 | 平铺卡片渲染、绑定态、加载中 ≠ 空、清理入口需二次确认 |
| 判断力 | 每批变异探针 | 至少覆盖：删除 cwd 回退、删除 enabled 保护、用 `agents.list()` 代替 `persistence`、去掉宽限期 |

## 9. 交付顺序

| 步 | 内容 | 独立可验证 |
| --- | --- | --- |
| 0.9.0-a | 配置 `revision` + 装配快照一致性 | ✅ 修现有隐患，不依赖其它 |
| 0.9.0-b | `workspaceRegistry` 索引 + workspaceId 优先、cwd 回退 | ✅ 纯宿主侧 |
| 0.9.0-c | 工作区平铺卡片 UI（替换设置页分组） | ✅ 依赖 b |
| 0.9.0-d | Session 覆盖 + sidecar + 合并 | ✅ 依赖 a |
| 0.9.0-e | 回收（命令 + 按钮，第一版 dry-run） | ✅ 依赖 d |

每一步独立提交、独立跑全链。**a 必须先做**：它是地基，且修的是现在就存在的隐患。
