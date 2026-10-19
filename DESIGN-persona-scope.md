# 人设工作区绑定（0.8.1 设计草案）

> 状态：**部分交付，UI 已撤下**。0.8.1-a（纯函数层）、0.8.1-b（宿主侧解析）、0.8.1-c（绑定路由）
> 的代码全部保留并仍由断言守着；**0.8.1-d 的设置页分组在 0.8.0 发版前被撤下** —— 按目录绑人设
> 将被 **0.9.0 的三级隔离**（Global → Workspace → Session）整体接管，而它的交互是按「目录字符串」
> 思考的，与工作区平铺卡片完全不同。
> 本文件继续作为 0.9.0 的设计输入：§1–§6 的目标与取舍仍然成立，§7 的 UI 形态会被重写。
> 本文件描述 0.8.1 的目标、取舍与验收方式；§10 的分层编号沿用草案写作时的 0.8.0-a..d，
> 实际发版本号为 **0.8.1-a..d**（草案写作期间路线图调过一次序：0.8.0 让给了变更审计与回滚）。
> 前置阅读：`lib/personas.mjs` 文件头四条设计约定、`RELEASE_NOTES.md` 的 v0.7.2 段落、`PUBLISHING.md` 的发版流程。

## 1. 目标

让**目录**决定 Agent 用什么人设。

用户在 `D:\项目A` 打开会话，Agent 自动是「资深架构师」；在 `D:\项目B` 打开，自动是「极简主义者」；不配置时，行为与现在完全一致。配置一次，之后每进这个目录都自动生效，包括子目录与新会话。

一句话：**把「每次手动切人设」变成「环境自带人设」。**

## 2. 为什么是目录键，而不是会话键

曾考虑过「按 session 绑定」。否决理由是一条硬约束：

**子代理会继承父会话的目录，但拿到全新的 sessionId。**

宿主 `dsh-subagent/lib/index.js` 的 `childSessionMeta`：

```js
function childSessionMeta(parent, childDepth, isSeeded) {
  const parentHeader = parent.session.header;
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx);
  return {
    ...(parentHeader.cwd !== void 0 ? { cwd: parentHeader.cwd } : {}),
    ...(agentPreset === void 0 ? {} : { agentPreset }),
    parentSession: parentHeader.id,
    isSeeded,
    origin: 'subagent',
    delegationDepth: childDepth
  };
}
```

`cwd` 原样继承、`id` 全新。纯会话键的方案下，用户在主会话绑了人设、派一个子代理出去，子代理会**静默回落**到全局默认 —— 而且没有任何提示。这是不可接受的。

同理，跨项目来回切换时目录键零操作、会话键每次都要重设。

| 维度 | 目录键 | 会话键 |
| --- | --- | --- |
| 子代理继承 | 零成本自动继承 | 键变了 ⇒ 静默回落 |
| 跨项目切换 | 进目录自动生效 | 每新会话重设一次 |
| 同一项目跑两种人设 | 需靠会话层覆盖 | 天然支持 |
| 数据清理 | 无状态 | 每会话一条，需随 agent 回收 |
| Windows 路径坑 | 需规范化（大小写 / Junction） | 无 |

结论：**目录是主键**，会话层仅作为显式覆盖存在（见 §5）。

### 2.1 子代理走哪条路径要分清

同一份源码里有**两条**子代理 cwd 路径，不要混为一谈：

| 路径 | 载体 | cwd 来源 |
| --- | --- | --- |
| **进程内子代理**（`dsh-subagent` 内部） | `childSessionMeta(parent, childDepth, isSeeded)` | 原样继承 `parentHeader.cwd` |
| **外部进程子代理**（`resolveChildCwd` / `validateConfiguredCwd`） | 导出给插件调用的 API | 部署配置的 `cwd` 覆盖值优先，其次父会话 |

`resolveChildCwd` 在全树**没有任何调用点** —— 它是导出给插件消费的，宿主内部不自己走。进程内子代理（也是日常对话里唯一会出现的那种）走的始终是 `childSessionMeta`。

**设计含义**：目录隔离下，子代理继承父会话目录 ⇒ 子代理也用人设。这是**刻意**的 —— 主会话用「资深架构师」，它派出去调研的子任务也应该按同样的专业口吻回答，而不是突然变成出厂默认。

但要注意：若将来某个部署给自己配了 `cwd` 覆盖，外部进程子代理的 cwd 可能与父会话**不同** ⇒ 它会命中另一条绑定（或回落）。这是正确行为，但属于需要在文档里说清的情况，不是 bug。

## 3. 命中规则：一条绑定 = 一棵子树

### 3.1 规则

1. **目录即键。** 同一目录重复绑定 = 改绑，不是新增。
2. **前缀继承。** 绑定 `D:\项目A` 后，`D:\项目A\子模块` 也用它 —— 用户绑目录的意图就是「这棵树都归它」。
3. **允许嵌套绑定，最长前缀优先。** 若同时存在 `D:\项目A` → 资深架构师、`D:\项目A\实验性重构` → 头脑风暴伙伴，则后者目录下的会话用头脑风暴伙伴，其余兄弟目录仍用资深架构师。
4. **子代理天然继承**，因为子代理继承 `cwd`（§2）。
5. 最坏情况回落全局配置 —— 与今天的行为一致。

嵌套绑定**不加写入限制**。曾设计过「父目录已有绑定时拒绝新增子绑定」的约束，已撤回：两个不同的键在结构上并不冲突（用户的判断是对的），真正需要决定的不是「能不能存」，而是「一个会话同时命中两条时谁生效」，而这个问题只由规则 3 回答。

### 3.2 命中判定必须落在文件边界上

前缀比较**不能**是裸字符串 `startsWith`。否则 `D:\项目A` 会错误命中 `D:\项目AB`。

判定条件：

```
candidate === bound || candidate.startsWith(bound + sep)
```

`sep` 取自规范化后的路径（Windows 用 `\`）。这条必须有独立断言 —— 它是整个功能里最容易写错、且错了以后表现得「像随机」的一行。

### 3.3 路径规范化

比较前统一规范化，四条：

1. 统一分隔符（`/` → `\`；或统一为 `/`，二者选一后写进注释）。
2. 去尾部分隔符（`D:\项目A\` 与 `D:\项目A` 视为同一目录）。
3. Windows 大小写不敏感 —— 大小写折算仅用于**比较**，展示仍用用户选择时的原样。
4. 解析符号链接与 Junction。**这不是理论问题**：本机 `profiles\desktop\node_modules\dsh-soul` 就是一个 Junction，`D:\AliuProject` 这类开发目录同样常见链接。

解析用 `realpath`。若目标不存在（目录被删、网络盘离线），**保留原样不报错** —— 离线盘不该让整个设置页崩掉。

## 4. 数据模型

**独立文件，不放进人设。**

`$DSH_HOME/soul-bindings.json`（与 `soul-config.json` 同级，见 `index.mjs:43-44` 的 `configPath()`）：

```json
{
  "version": 1,
  "bindings": {
    "D:\\项目A": "资深架构师",
    "D:\\项目A\\实验性重构": "头脑风暴伙伴"
  }
}
```

以**规范化目录**为键、人设名为值。

### 4.1 为什么不放进人设条目

「工作区绑定」是**本机环境事实**，不是人设属性。同一份「资深架构师」在台式机和笔记本绑的目录必然不同。

放进人设会带来三个具体问题：

1. 导出 / 分享人设时带出本机绝对路径 —— `D:\AliuProject` 对别人没有意义，还泄露了本机目录结构。
2. 内置人设不能带路径（它们随插件分发，是共享的）。
3. 删掉人设时，它的绑定该不该一起消失？放在独立表里，答案是「绑定指向一个已不存在的人设名 ⇒ 该条失效但保留」，语义干净。

### 4.2 失效引用

绑定值是人设名，人设可能被删或被改名。解析时：

- 目标人设不存在 ⇒ **忽略该条绑定**，回落（若父级有绑定则用父级，否则用全局配置）。
- 不自动删除这条绑定 —— 用户可能只是临时删了人设，重命名回来即恢复。
- 设置页对失效项**显式标注**（「人设『X』已不存在」），并给出删除入口。

### 4.3 文件读写

复用 `lib/store.mjs` 的既有能力（`readConfigFile` / `writeConfigFile` / `moveAsideConfigFile` / `describeConfigFailure`），不另造一套：

- 原子写：`writeConfigFile` 已经是「先写同目录 `.tmp` 再 rename」。
- 损坏文件：沿用配置文件的逃生口语义 —— 挪到一边、记备份路径、以空表继续运行，**不静默覆盖**。
- 内存缓存：与 `loadConfig()` 同理（`index.mjs:328-340`），但需注意绑定的读频率远低于配置（每轮装配一次），可以不做缓存，或缓存并在写后失效。
- 写队列：绑定写入复用 `enqueueConfigWrite` 的**串行化语义**，但**用独立队列实例** —— 两套数据在因果上无关（绑定的写入不依赖配置的当前值，反之亦然），共用一个队列只会把两者的延迟叠在一起。`index.mjs:365-372` 的实现可以直接照抄一份，或把 `enqueueConfigWrite` 抽成参数化工厂。

### 4.4 会话层覆盖的存储

会话层覆盖**不写进这个文件**。绑定表是「环境事实」（跨会话长期有效），会话覆盖是「此刻的选择」（随会话消失）。

选项：
- 存进宿主会话的 `projectionValues`（客户端插件已支持投影）。需要确认插件能否写入自己的投影命名空间。
- 或存进内存 Map，进程重启即失效 —— 语义上可接受（会话本身就是进程级对象）。

**0.8.0 的建议：先做内存 Map。** 理由：会话覆盖本来就不该活得比会话久；存盘反而制造「重启后还记着我临时切过」这种需要额外解释的行为。若后续发现需要持久化，再迁移。

**但要注意**：进程内保存会话对象时要用 `agent/disposed` 事件（`dsh-agent/lib/types/runtime-types.d.ts:240-242`）清理，否则 Map 会随会话数无限增长。

## 5. 解析层级与项目设置的关系

**三层，从具体到宽泛：**

```
会话层覆盖（仅当用户显式设置）  →  目录绑定（最长前缀）  →  全局配置（现状）
```

### 5.1 会话层为什么保留

它是唯一的安全阀：同一台机器、同一个项目，今天想做重构用它、明天想做评审用另一个。没有它，目录绑定会变成一种「进去了就改不掉」的强制。

但**必须是显式的**：用户在会话里选人设，**不自动**变成会话层覆盖。否则「我刚选的人设，为什么新开会话又变回去了」是必然会被问的问题 —— 而且用户答不出来。

会话层覆盖的入口：设置页「当前会话」区块显示 `本次会话临时改用：X [恢复为目录绑定]`，只在覆盖值与目录解析结果不同时出现。

### 5.2 「项目设置」的定位

用户可能把「绑定目录」理解成「给这个项目建一份项目设置」。需要明确区分：

- **项目设置（假设宿主将来提供）**：进这个项目就自动带上模型、权限策略、技能集。
- **人设绑定（本设计）**：进这个目录就用这个人设。

两者**不合并**。理由：人设是排他的（一次会话只注入一个 `soul:persona` section），而项目设置里其他项是累加的（权限、技能）。把它们塞进同一个概念会让「我改了人设为什么权限也变了」这类问题无处解释。

（关于「预设 = 语气 + 能力集」的想法 —— 让预设声明推荐启用哪些 skill/工具 —— 本版**不做**。自动开关工具涉及权限，代价与风险都不在一个量级。）

## 6. 宿主契约（已逐条查证）

### 6.1 装配期能拿到 agent 与它的 cwd ★

宿主 `dsh-agent` 给 `AssembleContext` 打了类型补丁（`dsh-agent/lib/types/runtime-types.d.ts:14-19`）：

```ts
declare module '@deepseek-ai/dsh-system-prompt' {
    interface AssembleContext {
        /** Agent for this assembly; absent on diagnostics. When present, `scope` must identify the same agent. */
        agent?: Agent;
    }
}
```

装配时宿主构造的上下文（`dsh-agent/lib/index.js:291-297`）：

```js
function assembleContextFor(agent, signal) {
	return {
		agent,
		scope: agent,
		...(signal === void 0 ? {} : { signal })
	};
}
```

调用点：`dsh-agent-loop/lib/index.js:907`
`const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));`

会话目录同步可达（`dsh-session/lib/types/types.d.ts:69`，`SessionHeader.cwd`，注释「Immutable validated storage metadata, kept outside the conversation event log」）：

```js
agent?.session?.header?.cwd
```

**结论：section 的 `text` 回调每轮都能按 cwd 解析人设，无需任何按 agent 注册的机制。**

这是本设计里最重要的简化 —— 它把「隔离」从「注册期的作用域技巧」降级成「装配期的一次查表」。

### 6.2 备选路径（本设计不采用）

宿主 `systemPrompt.section()` 的作用域语义支持「同名 section 在 agent 作用域内覆盖全局」（`dsh-system-prompt/lib/index.js` 的 JSDoc 原文：「A scoped section shadows a global section with the same name」；`ScopedLayers.merge` 实现为逐层 `set`，nearest wins），且宿主 `dsh-agent-instructions` 那类插件走的正是「按 cwd 分层」的思路。

已知可用的三条路：

| 方案 | 机制 | 何时采用 |
| --- | --- | --- |
| **A（本设计）** | `text: (ctx) => resolve(ctx?.agent?.session?.header?.cwd)` | 默认 |
| B | 在 `agent.ctx` 里注册同名 section 覆盖全局 | 若将来出现「同一 agent 内也要按条件切换」的需求 |
| C | `agent/pre-step` 里插一条 context 消息 | 若需要每步动态变化（宿主自己的 AGENTS.md 就是这条路） |

选 A 的理由：改动最小，且**不触碰宿主的作用域机制** —— B 需要维护「每 agent 一个注册 + 随 agent 销毁回收」，C 需要处理消息去重与 inbox 同步，两者都在增加状态。A 是无状态的。

### 6.3 注入通道要逐 agent 编译

`injectPromptToAllAgents`（`index.mjs:558-631`）遍历 `agents.list()` 向每个 agent `inject` 一条用户消息，用于「保存后立刻生效」。

**通道保留，但编译粒度必须改。** 现在是一个全局文本（`index.mjs:590` 的 `compilePrompt(config)`）发给所有 agent —— 工作区隔离下这会把 A 项目的人设注入 B 项目的会话，比不注入更糟。必须改成：循环体内按该 agent 的 `cwd` 解析人设、各自编译。

循环体拿得到 agent 身份（`index.mjs:597` 的 `for (const agent of listed)`），所以这次改动局限在循环内部，不需要重构函数签名。

### 6.4 三类变更都要触发刷新

`refreshPromptAndInject`（`index.mjs:633`）触发条件都是「配置的提示词字段变了」（`diffKeys` → `promptChanged`）。已知调用行（用于定位，不是完整列表）：`index.mjs:695`、`:807`、`:935`、`:1387`、`:1431`、`:1440`、`:1446`。

（该标识符在 `index.mjs` 内共 **13 处命中**（实测），含定义、调用与注释提及。**实施时重新 `grep` 计数，不要把这个数字当成契约** —— 新增绑定路由会合法地增加调用点。文档里写死数字的代价是：后人看到数字对不上，会以为自己改错了。）

工作区隔离引入**第三类**会改变提示词的事实：**新增或删除绑定**。它不改 `soul-config.json`，所以现有的 `promptChanged` 门控看不见它。绑定路由的写路径必须自己调用刷新。

## 7. 客户端 UI

### 7.1 设计原则

**「绑定」是配置动作（低频，要增删改查）；「当前用什么」是状态（高频，只读）。两者不塞进同一个控件。**

UI 必须先回答「我这个项目现在是谁」，再让用户改。

### 7.2 位置

设置页新增第 4 组「工作区绑定」，插在「人设预设」与「Agent 工具」之间。落点：`client/index.mjs` 中 `group.personas` 分组渲染（约 2017 行）与 `group.tool` 分组渲染（约 2300 行）之间的锚点。

### 7.3 三块结构

1. **当前会话目录卡**：路径 + `[选择目录…]`；下方三行「生效人设 / 来源 / 操作」。
   **「来源」一行是灵魂** —— 显示 `D:\项目A（上级目录继承）` 或 `全局配置`。没有它，用户在子目录里看到别的人设会以为是 bug。
2. **绑定列表**：按层级排序，用 `└` 前缀画出「一条绑定 = 一棵子树」；当前目录所在行高亮；每行「人设名下拉 + [解绑]」；失效人设标注并给出删除。
3. **未绑定回落行**：`未绑定的目录使用全局配置 · 🐋 苏格拉底式提问者 [改]` —— 把隐式行为显式写成一条可改的规则。

### 7.4 操作入口

- **绑新目录默认点选**：`ctx.uiWorkspace.pickDirectory(): Promise<string | null>`（`null` = 用户取消）。宿主客户端插件 `dsh-client-ui-workspace` 提供，本机（Windows + `127.0.0.1` 回环）走 native 后端，可调起系统选择器。
- **改绑**：列表行内 `<select>`，不弹窗。
- **解绑**：内联二次确认（与删除人设同一套 armed 态 + 5s 超时），**不用原生 `confirm`**。
- **会话层覆盖**：只在「覆盖值 ≠ 目录解析结果」时出现 `本次会话临时改用 X [恢复]`。

### 7.5 降级路径

`pickDirectory()` **不是所有连接方式下都可用**。宿主 `dsh-host-directory-picker` 的能力是判别联合：

- `kind: 'native'` ⇒ `pick(signal): Promise<string | null>` 可用
- `kind: 'browse'` ⇒ 只有 `list` / `createDirectory`，**没有 `pick`**

判定由 `dsh-host-directory-picker-auto` 在启动时做一次：`bindHost !== '127.0.0.1'` 或 SSH ⇒ browse；Windows / macOS ⇒ native；Linux 需 `DISPLAY`/`WAYLAND_DISPLAY` + PATH 里有 `zenity`/`kdialog`。

**做法：catch 到错误再降级，不要预判后端种类。**

在 browse 后端上调 `pick()` 会确定性地失败 —— `dsh-api-workspace-controller` 的 `requireCapability` 抛 `directory-picker/unavailable`（带 `capability` 字段）。但 `pickDirectory()` 把这个错误包装成了普通 `Error`（只保留 message 文本），所以**判别方式只能是调用失败后降级**，而不是读 `kind`。

降级形态：把按钮换成带说明的文本框 —— 当前连接方式无法调起系统目录选择器，请手动粘贴路径。

**不自建浏览式选择器。** 宿主已有 `dsh-client-ui-directory-picker-browse`（48.3 KB，含面包屑与新建文件夹）。重复实现是净负债。

### 7.6 注入写法（硬约束）

现有 `client/index.mjs:2614` 是 `const inject = ['slots', 'locale']`。

**不能**改成静态 `['slots', 'locale', 'uiWorkspace']` —— 服务缺失时整个插件不激活，设置页连同人设卡一起消失。

必须用动态注入：

```js
ctx.inject(['uiWorkspace'], (scope) => { /* 注册带动目录按钮的区块 */ })
```

宿主 10 个客户端插件都用这个形态（`dsh-client-ui-agent-preset`、`approval`、`chat`、`commands`、`conversation`、`input-trigger`、`message-feedback`、`model-selection`、`sidebar-browser`、`sidebar-documentpreview`）。

### 7.7 当前会话目录从哪来

⚠️ `settings.section` 槽位的 scope 是 **`root`**（`dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:73-77`），设置页**拿不到 sessionId**；`uiWorkspace` 的 `mainReference` / `selection` 也是 `private`。

可用的取数路径（按优先级）：

1. **宿主侧解析后经路由返回** —— 设置页请求 `/api/soul/bindings` 时，宿主遍历 `agents.list()` 取活动 agent 的 `session.header.cwd`。**这是推荐路径**：权威、且天然覆盖「子代理也各有一份 cwd」的情况。
2. 客户端 `ctx.sessions.list` 快照（`SessionSummary` 含 `cwd?: string`），比对选中项。仅用于客户端内部的即时反馈。

**必须显示「会话 cwd」而不是「工作区 cwd」。** 两者可能不同（工作区是 `D:\AliuProject`，会话 cwd 是 `D:\AliuProject\dsh-plugin`）；显示错粒度会让用户绑错层级。

### 7.8 三个细节

1. 路径**截中段**显示（尾部 `…\dsh-plugin`，悬停给全路径）。
2. **规范化后再比较**（§3.3），展示用原样。
3. **底栏不新增点击**。底栏 `soul-quick-toggle-name` 只加 `title` 说明来源，所有操作留在设置页。

## 8. 安全与边界

- **绑定文件读取一律当不可信输入。** 逐条校验：键是非空字符串、值是合法人设名（走 `sanitizePersonaName`）、拒绝原型污染键（`lib/config.mjs:105` 的 `FORBIDDEN_PERSONA_NAMES`）。
- **绑定内容绝不进提示词。** 路径本身不写进 system prompt，只用于选人设。避免把用户目录结构泄露给模型。
- **路径进 UI 要先转义。** 渲染路径时不能直接当 HTML 注入（React 默认转义，但 `title` 属性、`dangerouslySetInnerHTML` 之类要留意）。用户目录名里可以合法包含 `<`、`>`、`&`。
- **写路由要有 HTTP 方法校验。** 参考已修复的教训：`/api/soul/config/reset` 曾完全没有方法校验，任何方法（含 GET）都会执行破坏性写入。新增绑定路由**一律显式校验 `req.method`**。
- **绑定值必须是已存在的非内置人设。** 内置人设不可删但可被绑定（合法用法），不存在的名字一律拒绝写入 —— 否则用户会把 typo 当成「绑定生效了」。
- **路径长度上限。** Windows 上路径可能很长（尤其含 Junction 时）。写入前校验上限（建议 512 字符，超过 `sanitizePersonaName` 的宽松度但远小于请求体上限），超限拒绝而不是截断。
- **请求体上限**沿用 `index.mjs:309` 的 `MAX_BODY_BYTES = 64 * 1024`；绑定表本身很小，不需要放宽。
- **不做目录内容访问。** 绑定只需要一个路径字符串，不读目录、不列文件、不访问文件系统内容（`realpath` 除外）。

## 9. 影响的文件

| 文件 | 改动 |
| --- | --- |
| `lib/bindings.mjs` | **新增**。路径规范化、前缀匹配、绑定表读写与校验（纯函数，可独立测试）。**0.8.1-a 已完成**（430 行） |
| `lib/config.mjs` | 不改（绑定不进配置） |
| `lib/store.mjs` | 不改。绑定表复用它的 `readConfigFile` / `writeConfigFile` / `moveAsideConfigFile`，不另造一套原子写 |
| `index.mjs` | `registerSystemPrompt` 的 `text` 回调改为按 `ctx.agent` 解析；新增绑定 HTTP 路由；`injectPromptToAllAgents` 改为逐 agent 编译；绑定写入后主动刷新（§6.4） |
| `client/index.mjs` | 新增「工作区绑定」分组；`ctx.inject(['uiWorkspace'], ...)` 动态注入；新增文案键 |
| `scripts/verify-bindings.mjs` | **新增**（0.8.1-a）。绑定层纯函数与真实文件系统断言，47 项 |
| `scripts/verify-config.mjs` | 新增「绑定写入准入与路由」契约断言（HTTP 方法校验、写入后触发刷新） |
| `scripts/verify-client.mjs` | 新增 UI 行为断言（分组渲染、下拉、解绑二次确认、降级） |
| `scripts/verify-e2e-prompt.mjs` | 新增「不同 cwd 的会话拿到不同 persona section」端到端断言 |
| `package.json` | `verify` / `verify:strict` 链插入 `verify-bindings.mjs`（`verify-config` 有一条断言要求链覆盖 scripts 下全部 `verify-*.mjs`） |

## 10. 分层与实施顺序

每一步可独立验证、独立发布，不做「大爆炸」。下表编号沿用草案写作时的 `0.8.0-a..d`，
**实际发版本号为 `0.8.1-a..d`**（写作期间路线图调序，0.8.0 让给了变更审计与回滚）。

| 步 | 内容 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 0.8.1-a | `lib/bindings.mjs` 纯函数层 + 断言 | `verify-bindings`（47 项）+ 判断力探针 16/16 | **完成** |
| 0.8.1-b | 宿主侧解析接入 `registerSystemPrompt` + 逐 agent 注入 | `verify-e2e-prompt` W1–W15（多 cwd / Junction 身份键 / 降级） | **完成** |
| 0.8.1-c | 绑定 HTTP 路由（含方法校验）+ 端到端 | `verify-e2e-prompt` R1–R13（405 / 准入拒绝 / 写入即生效 / 解绑），判断力探针 18/18 | **完成** |
| 0.8.1-d | 设置页分组 UI + 点选 + 降级 | `verify-client` C29–C33（含 `pickDirectory` 抛错降级、`uiWorkspace` 缺席降级）+ `verify-config` 三条源文本契约（动态 inject / 词典键 / class 样式），判断力探针 6/6 | **已实现但撤下** —— 分组不再渲染，C29–C33 随之删除；组件与样式保留待 0.9.0 重写。`verify-client` 新增 C35 反向守住「设置页不得再出现它」 |

### 10.1 0.8.1-a 实施中被断言逼出的三处修正（均已落到代码与注释里）

1. **`bindingsPathFor` 不得用 `node:path` 的 `dirname`/`join`。** 它们**按运行平台**解析，
   于是在 Windows 上处理 `/home/u/.dsh/soul-config.json` 会得到 `\home\u\...` ——
   断言随即无法在同一台机器上验证两套路径语义。改为只做一次「最后一个分隔符」切分
   （与 `lib/history.mjs` 的 `historyPathFor` 同款）。
2. **UNC 前缀只在 Windows 分隔符下识别。** POSIX 的 `//` 按规矩等同于 `/`，
   若也当 UNC 处理，`//` 会被原样保留，于是它与 `/` 成了两条不同的绑定。
3. **`bindingRefusal` 的第三关必须拿 trim 后的名字查库。** 直接拿原串查的话，
   `我的自定义人设 `（末尾一个空格）会在第一关通过、第三关被判「不存在」——
   拒绝理由与真实原因不符，用户看到的是一句自相矛盾的话。
   同时拆出 `normalizeBindingEntry`（回答「写什么」）与 `bindingRefusal`（回答「能不能写」），
   否则调用方必然自己再 trim 一遍值，而那正是不一致的来源。

另外明确一条**刻意的边界**：`normalizeDirPath` **不解析 `.` / `..`**（那归 `resolveDirIdentity`
的 realpath 管）。不做的后果是失败方向安全的 —— `D:\项目A\sub\..` 会原样留下成为一条
永远命中不了的绑定；反过来若用纯文本规则折叠 `..`，当 `sub` 是符号链接时折叠结果是**错的**。

## 11. 已知风险

1. **规范化在 Windows 上的不确定性。** Junction 与符号链接解析可能失败或很慢（网络盘）。缓解：`realpath` 失败即保留原样；比较时再做一次大小写折算。
2. **「为什么这个目录是那个人设」的解释成本。** 缓解：UI 的「来源」一行必须写清楚是哪条绑定命中的，以及它是父级继承。
3. **活跃 agent 列表在装配期的可见性。** `text` 回调拿到的 `ctx.agent` 是宿主注入的，不依赖 `agents.list()`；但 §6.3 的注入路径依赖 `ctx.get('agents')`，服务缺失时该路径会退化（现有实现已有告警与 `deliveryState.injectionProblem`）。
4. **诊断装配的下落。** 宿主注释写明 `agent` 在诊断（diagnostics）装配时**缺席**。`text` 回调必须容忍 `ctx.agent === undefined` ⇒ 回落到全局配置，不得抛错。
5. **「绑了但没生效」的排查成本。** 若 `cwd` 为 `undefined`（会话没有工作目录，宿主允许这种情况），任何绑定都不会命中。UI 的「当前会话目录」区块必须对这一情况有明确文案，而不是显示空白让用户猜。
6. **嵌套绑定的心智负担。** 即使 UI 画出了层级，用户仍可能忘记自己三个月前在某子目录绑过东西。缓解：命中父绑定的行也要能看出「下面有更具体的绑定」。
7. **每轮装配都做路径规范化会累积开销。** `realpath` 是 I/O。缓解：绑定表在加载时规范化一次并缓存；会话 `cwd` 的规范化结果按 agent 缓存（`cwd` 不可变，可安全缓存到 agent 销毁为止）。

## 12. 明确不做

- **不做「预设 = 语气 + 能力集」**（预设声明推荐启用哪些 skill/工具）：自动开关工具属权限敏感操作，且会让「预设」这个词承担两种互不相关的语义。
- **不做逐层覆盖**（每个子目录叠加一层）—— 用户已明确否决，且它与人设的排他性冲突。
- **不自建目录浏览器**（复用宿主 §7.5）。
- **不把绑定写进人设条目**（§4.1）。
- **不合并「项目设置」与「人设绑定」**（§5.2）。
- **不做「绑定到文件」**（如 `D:\项目A\package.json` 需要特定人设）：键是目录，文件级绑定会让「哪条更具体」的判定复杂化，而收益不明确。
- **不做按目录自动切换审批策略 / 模型**：那是权限敏感面，见 §5.2。
