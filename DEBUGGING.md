# 故障排查与本地调试

## 一、安装 / 卸载 / 查看

`dsh plugin` 是一个 **pnpm 转发器**：它先在 profile 目录里执行 `pnpm <你的参数>`，成功后把 `dsh.profile.bundles` 与"实际安装结果"做一次调和——凡是解析得到、且声明了 `dsh.bundle.patch` 的依赖会被追加进 bundles 层栈；被移除或已不含该声明的依赖会从层栈中摘除。因此 `remove` 之后**不需要手工改 `package.json` 里的 bundles 列表**。

```bash
# 安装（registry 版本）
dsh plugin --profile web add dsh-soul

# 安装（本地目录：file: 语义，会把包复制进 profile，见第二节）
dsh plugin --profile web add ./dsh-soul
dsh plugin --profile web add file:<插件源码绝对路径>

# 查看已装（转发给 pnpm）
dsh plugin --profile web list

# 升级
dsh plugin --profile web update dsh-soul

# 卸载
dsh plugin --profile web remove dsh-soul
```

卸载后如需彻底清干净，还要手动删除插件自身不管理的用户数据：

```text
$DSH_HOME/soul-config.json      # 未设置 DSH_HOME 时在 ~/.dsh/ 下
```

> `id` 冲突提醒：本插件 `cordis.patch.yml` 中 `id` 为 `soul`、`name` 为 `dsh-soul`。同一 profile 内不要出现第二个 `id: soul` 的插件，否则配置树会打架。

## 二、本地开发版本（改源码即时生效）

### 根因：默认安装是"复制"，不是"链接"

`dsh plugin add <本地路径>` 走 pnpm 的 `file:` 协议，pnpm 会把整个包**复制**一份到 profile 的 `node_modules`。DSH 加载的是那份副本：

```text
改源码 → 副本不动 → 页面纹丝不动
重启服务也没用（重启 ≠ 重装包）
```

自检：若 `node_modules/dsh-soul` 是真实目录且内容与源码不一致，就是复制版。

### 三种方案对比

| 方案 | 命令 | 改源码后 | 代价 |
| --- | --- | --- | --- |
| A. 每次重装副本 | `dsh plugin --profile web remove dsh-soul` → `add file:<绝对路径>` | 需**先 remove 再 add** + 重启宿主 + 硬刷新 | 最稳，但每次改动都要重来；**只 `add` 不会更新**，见下方 2.1 |
| B. `link:` 协议 | `dsh plugin --profile web add link:<绝对路径>` | 软链直指源码，预期即时生效 | **Windows 上不可靠，见下方警告** |
| C. 目录联接 | 用 `mklink /J` 手工替换 `node_modules/dsh-soul` | 即时生效 | 绕过 pnpm，后续 install 可能清理掉联接 |

### 2.1 为什么只 `add` 不会更新（实测）

`file:` 依赖在 pnpm 的 lockfile 里**按路径登记**，pnpm 不比对目录内容。源码改了、路径没变 ⇒ 直接判定"已是最新"，副本**原地不动**。

实测（副本停在 0.6.0、源码已到 0.6.2）：

```text
dsh plugin --profile web add file:<绝对路径>
→ Already up to date        # 没有任何报错，也没有任何警告提示你没装上
→ node_modules/dsh-soul 仍是 0.6.0
→ 并且继续按旧 package.json 报 peer 不兼容
```

**正确做法是「先移除、再安装」**——输出里出现 `Packages: +1` 才是真的装了：

```bash
dsh plugin --profile web remove dsh-soul
dsh plugin --profile web add file:<绝对路径>
```

装完务必核对副本版本，这是最容易踩空的一步：

```powershell
(Get-Content "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-soul\package.json" | ConvertFrom-Json).version
```

或者直接选方案 C 的联接，从根上绕开复制语义：改源码即时生效，不存在"忘了重装"。

### ⚠️ 关于方案 B（`link:`）的 Windows 警告

本机实测（pnpm 11.22.0 / Node 22.22.2 / 该 profile 使用 `nodeLinker: hoisted`）：

- pnpm 的 `link:` 走 `fs.symlinkSync(..., 'dir')`，即**目录符号链接**；
- Windows 上创建目录符号链接需要**开发者模式**或管理员权限。权限不足时，实测结果是**静默退化成一个空目录**：`readlinkSync` 报 `EINVAL`、`lstat().ino === stat().ino`、`readdir` 返回空；
- 后果比"改源码不生效"更糟：插件目录里**什么都没有**，DSH 会因找不到 `index.mjs` 而直接加载失败。

对照验证：`fs.symlinkSync(..., 'junction')` 与 `cmd /c mklink /J` 在**不需要任何特权**的前提下均正常工作（`readlinkSync` 可解析、内容可读）。所以本机应选**联接**，而非符号链接。

执行 `link:` 之前先确认「设置 → 系统 → 开发者选项 → 开发者模式」是否已开启；开启后 `link:` 才可信。

> **补充（实测：同一台机器上两种结果并存）**：`web` profile 用 `file:`（复制，需 remove + add 才更新，见 2.1）；`desktop` profile 用 `link:` 且**工作正常** —— `node_modules/dsh-soul` 下能看到 `DEBUGGING.md`、`.gitignore`、`.github/`、`screenshots/` 等**不在 `files` 白名单**里的文件，内容随源码即时更新。可见链接权限是否可用取决于当前机器/账号状态，不能一概而论。
>
> **判别链接到底生没生效**（最可靠的一条，不需要任何工具）——看 `node_modules/<包名>` 里有没有 `files` 白名单**之外**的文件（`DEBUGGING.md`、`.gitignore`、`.github/`）：
>
> | 目录内容 | 结论 | 改源码后 |
> | --- | --- | --- |
> | 有白名单外的文件 | 直连源码的真实链接 | 即时生效 |
> | 只有白名单内的文件 | 复制副本 | **不生效**（需 remove + add） |
> | 空目录 / 零星条目 | `link:` 已退化成空目录 | 插件加载失败 |

### 方案 C：目录联接（本机推荐）

```powershell
$web = "$env:USERPROFILE\.dsh\profiles\web"
$src = "<插件源码绝对路径>"

# 1) 备份原副本（可回滚）
Rename-Item "$web\node_modules\dsh-soul" "dsh-soul.bak"

# 2) 建立联接，指向源码目录（无需管理员权限）
cmd /c mklink /J "$web\node_modules\dsh-soul" "$src"
```

为避免后续 `pnpm install` 覆盖联接，可把 `dsh-soul` 从 `package.json` 的 `dependencies` 中移除、但在 `dsh.profile.bundles` 中保留 `dsh-soul`。调和逻辑只对"依赖中列出"的条目做增删，因此这样它既不会被摘出层栈，也不会被 pnpm 重装成副本。

> 注意：扁平化（`nodeLinker: hoisted`）布局下，`pnpm install` 仍可能把不在依赖树里的目录当作多余项清理。届时重新执行第 2 步即可。
> 回滚：删除联接目录，再把备份改回原名。

### 改完源码后的生效范围

| 改动位置 | 需要做什么 |
| --- | --- |
| 宿主端 `index.mjs` / `lib/*.mjs`（含 `personas.mjs`） | **完全重启 DSH**（Node 进程需重新 import） |
| 客户端 `client/index.mjs` | 硬刷新浏览器 `Ctrl+Shift+R` |
| `cordis.patch.yml` / `package.json` | 重装 + 重启 |

## 三、验证方式（四层，由浅入深）

### 1) 配置层（不启动服务）

```powershell
dsh --profile web --dump-config
```

输出中应能看到 `soul` 这一行（`name: dsh-soul`），说明 patch 已正确合入配置树。包名写错会在这一步暴露为 `Cannot find package`。

### 2) 版本核对（确认跑的是不是你的源码）

```powershell
# 已装副本的版本号
(Get-Content "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-soul\package.json" | ConvertFrom-Json).version

# 若用联接：Target 应输出源码绝对路径，而不是空白
(Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-soul").Target
```

`package.json` 的 `version`、`client/index.mjs` 的 `VERSION` 常量、`RELEASE_NOTES.md` 三处应一致（本版均为 `0.7.0`）。

### 3) 客户端产物（确认浏览器拿到新代码）

打开 `http://127.0.0.1:3080` → DevTools → Network，过滤 `soul`，应看到：

```text
/plugins/soul/client.js?rev=<12 位内容哈希>
```

`rev` 是客户端 bundle 的 **sha1 内容哈希前 12 位**，内容一变 `rev` 即变。若 404 或内容为空，说明包没装好、或 `exports["./client"]` 解析失败。也可直接探测：

```powershell
curl.exe -s "http://127.0.0.1:3080/plugins/soul/client.js" | Select-String "soul-trail"
```

出现 `soul-trail` 字样即说明新客户端代码已送达。

### 4) 功能与动效（本版新增「输入框光轨」）

| 检查项 | 预期 |
| --- | --- |
| 设置页 →「Agent 工具」分组 | 可见「输入框光轨」开关，默认开启 |
| 颜色区 | 6 个预设色板 + 原生取色器 + HEX 输入框，三路联动 |
| 实时示例 | 切换颜色 / 速度 / 粗细，示例光轨同步变化 |
| 触发条件 | 仅当 Agent 处于回复中（`session.running === true`）且开关开启时出现 |
| 动效形态 | 单段拖尾沿输入框边缘匀速绕行，头部最亮、尾部渐隐，**与边框完全重合为一条线** |
| 系统偏好 | 开启「减少动态效果」后动画停止（`prefers-reduced-motion`） |
| 持久化 | 保存后重开设置页四项参数不变；`$DSH_HOME/soul-config.json` 中出现 `trail*` 四字段 |
| 不污染提示词 | 只改光轨颜色 → 仅提示「已保存」，系统提示词**不变**；改昵称 / 风格才会改变提示词 |

> 光轨四项属于**纯外观配置**：计入"配置已变更"（用于保存提示与脏检查），但被排除在 `promptChanged` 之外，因此不会刷新系统提示词。

### 5) 宿主等价性回归（0.7.1 起）

0.7.1 移除了「向所有活动会话注入最新配置」，改为**完全依赖**「宿主每个 step 重新求值 section 的 `text` provider」。这条依赖属于宿主行为：一旦宿主改成缓存文本，「改配置 → 下一轮生效」会**静默失效**（不报错，只是配置不再生效 —— 最难排查的一类）。两个脚本把这条链路的**两端**各自钉住：

```bash
npm run verify:host    # 宿主端：真实 SystemPrompt + 真实 Cordis Context + 切片 SystemPromptProjection
npm run verify:e2e     # 插件端：真实 index.mjs + 假宿主，走 HTTP 保存 → section 立刻读到新文本
```

| 脚本 | 证明什么 | 关键断言 |
| --- | --- | --- |
| `verify:host` | 宿主每次装配都重新求值；文本变了才提交新快照 | A2/A3：改配置后**再装配**即读到新文本，改回又能读到旧值（双向可变 ⇒ 无缓存）；B4：文本未变**不提交**（不堆消息）；C3：`preStep` 每个 step 都调 `assemble` |
| `verify:e2e` | 保存配置后 provider 确实返回新文本 | E4/E8：保存后立即生效（同一进程、无需重启、无需重新注册）；E10：纯外观字段不触发刷新；E13：全程**未索要 `agents` 服务**（注入通道已彻底移除） |

两者都内置**判断力对照**（把关键条件改坏，对应用例必须失败）：`verify:host` 把 `text` 退化为静态字符串、并删掉「文本相等则不提交」；`verify:e2e` 把 provider 读的配置源换成 `DEFAULT_CONFIG`。**DSH 升级后请重跑 `npm run verify:host`** —— 它是这条链路唯一的自动化护栏。

> 两者都并入 `npm run verify`。定位不到 DSH 时优雅跳过（退出码 0）；`verify:host` 的 B 层若在宿主源码里找不到 `SystemPromptProjection` 也会跳过（宿主实现已变），A / C 层仍照常执行。

## 四、常见报错

| 报错 / 症状 | 原因 | 解决 |
| --- | --- | --- |
| `dsh-soul@x.y.z 与 DSH a.b.c 不兼容（要求 …）` | 插件声明的 peer 范围不含当前 DSH 运行时版本 | 见下方 4.1 |
| `Cannot find package 'dsh-soul' imported from …\profiles\web\` | 配置树里有插件行，但包没进 `node_modules` | 先 `dsh plugin add`，再启动 |
| 插件目录存在但为空 | `link:` 在无开发者模式的 Windows 上静默退化成空目录 | 改用 `mklink /J` 联接 |
| 设置栏目不显示 | 插件没装进当前 profile / DSH 未完全重启 / 页面没刷新 | 重装 → 重启 → 硬刷新 |
| 动效完全不出现 | 开关关闭 / Agent 未处于回复中 / `prefers-reduced-motion` 生效 | 逐项核对 |
| 输入框卡片高度不断变大、聊天区出现巨大空白（开着光轨时） | 光轨的 SVG 退回了常规流，形成尺寸正反馈 | 见下方 4.2；0.6.2 起已内置三层隔离与熔断 |
| 改源码后无反应 | 装的是复制副本 | 见第二节方案 C |
| `dsh web --patch ./x.yml` 报 `web takes none of …` | `web` 别名命令不接受全局选项 | 写全称 `dsh --profile web --patch …` |
| 配置保存了但 Agent 行为没变 | 新配置在下**一次**模型请求生效（section 在装配时求值，不会打断进行中的请求） | 先发一条新消息再观察；若仍不变见 4.5 |
| 自定义指令里写了 `{{…}}` 之后，**每个会话的每一轮**都失败 | 宿主提示词 section 默认开启严格插值，而插件不注册任何变量 | 见下方 4.3（0.7.1 起已关闭插值） |
| 昵称 / 风格 / 预设库突然全部为空 | `soul-config.json` 被写坏；旧版会静默回退默认值并把它写回磁盘 | 见下方 4.4（0.7.1 起改为拒绝写入 + 自动备份） |
| 保存时提示「为避免覆盖，本次保存已拒绝」 | 磁盘上的配置当前不可解析，写入被有意拦下 | 见下方 4.4：修复或删除该文件后重试 |

### 4.1 插件与 DSH 版本不兼容

**症状**：DSH 升级后，插件管理器（或 `dsh plugin` 输出）报

```text
dsh-soul@0.6.0 与 DSH 0.2.0-rc.2 不兼容（要求 @deepseek-ai/dsh-llm ^0.1.1-rc.2, @deepseek-ai/dsh-tools ^0.1.0-rc.6），
运行它可能导致崩溃或数据丢失。
```

**判定规则**（权威实现：`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）：

1. 只校验名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer；**`@deepseek-ai/cordis` 不参与判定**（所以报错只列 dsh-tools）；
2. 被比较的一方是 **DSH 运行时版本**（`dsh-app-boot/package.json` 的 version），不是这两个包各自的版本；
3. 判定式 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。`^0.1.1-rc.2` 的隐含上界是 `<0.2.0-0`，所以它会挡住整条 0.2.x 线。

**先确认是不是纯声明问题**：

```bash
npm run verify:compat                 # 自动定位本机 DSH
node scripts/verify-compat.mjs --dsh "<DSH 安装目录>"
node scripts/verify-compat.mjs --runtime 0.2.0-rc.2
```

输出会逐条给出「通过 / 不通过」，并标注判定方式（能取到宿主时会直接调用 DSH 的原生函数）。脚本末尾还会抽查 `defineTool` / `TOOL_RUNTIME_SCHEDULER` 与客户端 `inject` 包——这一层 DSH 不校验：

- 只有 peer 不通过、符号齐备 → 属**声明过期**，升级插件即可；
- 同时报符号缺失 → **代码也需要适配**，不能只改版本范围。

**三种处理方式**：

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| 升级插件（推荐） | `dsh plugin --profile web update dsh-soul` | 上游已发布声明兼容的版本 |
| 临时豁免 | `dsh plugin --profile web allow-version dsh-soul@0.6.0 --dsh-version 0.2.0-rc.2 --accept-risk` | 上游尚未发版，需先跑起来 |
| 参与修复 | 放宽 `peerDependencies` 上界并升版本发版 | 你是维护者（见 `PUBLISHING.md`） |

豁免查询与撤销：

```bash
dsh plugin --profile web version-exemptions
dsh plugin --profile web revoke-version dsh-soul@0.6.0 --dsh-version 0.2.0-rc.2
```

豁免写入 profile 目录下的 `compatibility.json`，且**只对写明的「包版本 + DSH 版本」组合生效**——升级任一侧都会重新触发校验。

> 豁免意味着 DSH 明确告知过「可能导致崩溃或数据丢失」。它适合临时验证，不适合长期使用；优先等插件发新版。

### 4.2 输入框卡片高度无界增长（尺寸正反馈）

**症状**（[issue #2](https://github.com/Aliuyanfeng/dsh-soul/issues/2)）：开启光轨后在长对话里连续读 `document.querySelector('[data-composer-card]').clientHeight`，数值单调增长（报告者实测 87 720 → 312 712 → 416 263 → 503 361 px），聊天区出现巨大空白面板、Agent 回复被顶出视口；**关掉光轨开关立即恢复**。

**机理**：光轨是一层「写在输入框卡片内部、尺寸随卡片变化」的绝对定位 SVG。若它的 `position:absolute` 未生效（被第三方皮肤 / 主题用更具体的选择器覆盖，或样式表没加载），它就会退回常规流、成为卡片 flex 列的一个子项；而它的高度由 `viewBox` 宽高比反推 ≈ 卡片自身高度，于是闭合成环：

```text
卡片变高 → ResizeObserver 触发 sync() → 按新尺寸改写 SVG 的 viewBox / rect
        → SVG 作为在流元素再变高 → 卡片再变高 → …
```

**自检**：光轨此时会在控制台打印

```text
[dsh-soul] 已停用输入框光轨：光轨样式被第三方样式表覆盖（position: static）
[dsh-soul] 已停用输入框光轨：输入框尺寸异常（疑似尺寸正反馈）
```

**定位命令**（在 DevTools Console 中执行）：

```js
const svg = document.querySelector('.soul-trail-svg')
getComputedStyle(svg).position   // 正常应为 "absolute"；若为 static/relative 即为根因
svg.getBoundingClientRect().height  // 正常应 ≈ 输入框卡片高度（+4px）
```

若 `position` 不是 `absolute`，把责任样式找出来（同一 Console）：

```js
[...document.styleSheets].flatMap((s) => { try { return [...s.cssRules] } catch { return [] } })
  .filter((r) => r.selectorText && r.style && r.style.position &&
                 (svg.matches(r.selectorText) || (svg.closest(r.selectorText.replace(/[^,]+$/, '*')) )))
```

**处理**：

| 情形 | 做法 |
| --- | --- |
| 0.6.2 及以上 | 已内置三层隔离（零高度锚点 / 内联几何 / `contain:strict` + 墨迹内收）与两道熔断，最多表现为「光轨不显示 + 一条 console 警告」，不会再撑大布局。`npm run verify:trail` 可在离线环境回归这套隔离 |
| 0.6.0 / 0.6.1 | 升级到 0.6.2+；临时规避可先关掉光轨开关 |
| 确认是某皮肤 / 主题覆盖 | 该皮肤把 `position` 施加到了插件的 `svg` 上，属皮肤作用域过宽；插件侧已用内联样式兜住，无需你改皮肤 |

> 复现与验证方法（离线、不需要跑 DSH）已固化为 `npm run verify:trail`：从 `client/index.mjs` 原样抽出渲染层，注入静态页，在无头浏览器里跑一组确定性模型——正常条件必须空操作（60/60 次同步）、几何被 `!important` 打回常规流后必须不撑大卡片、屏蔽熔断后**挂锚点仍稳定而挂卡片必现正反馈**（判断力对照，实测 272px → 8 912px）。它需要 Chrome / Edge，起不来时自动跳过；受限环境可用 `--emit <页面>` + 手动 dump-dom + `--dump <文件>` 两段式跑。

### 4.3 自定义指令里出现 `{{…}}` 会让整轮对话失败

**症状**：在设置页「自定义指令」里写了模板语法（如 `{{name}}`、`{{cwd}}`、`{{ item.id }}`）并保存后，**每个会话的每一轮请求**都失败 —— 不是"那段文字被忽略"，而是 Agent 完全不回复。

**根因**：宿主 `systemPrompt` 的每个 section **默认开启提示词插值**（`interpolate: true`），且是严格模式：文本里每一对**完整的** `{{…}}` 都必须命中一个已注册变量，否则 `renderPrompt` 直接抛错（`malformed` / `unknown prompt variable`）。而 dsh-soul 的 section 从不注册任何变量 ⇒ 变量集为空 ⇒ **任何**一对完整花括号都必然抛错。

**为什么是"每一轮都失败"**：该抛错位于 `agent.step()` 开头且**没有 try/catch**，上层 catch 后 emit `agent/error` 并 rethrow；又因为 section 是全局注册、文本来自 `soul-config.json`，所以只要配置里还留着那对花括号，**所有会话的每一轮**都会失败（设置页走 HTTP、不经渲染，所以还能从 UI 里把配置救回来）。

**处理**：

| 情形 | 做法 |
| --- | --- |
| 0.7.0 及更早 | 打开设置页 →「自定义指令」，删掉里面的 `{{…}}` 并保存，即可恢复 |
| 0.7.1 及以上 | 已修：section 注册显式 `interpolate: false`，花括号一律**按字面保留**，不再参与插值 |

> 修复的附加收益：预览与实际生效的文本**逐字符一致**。0.7.0 时「提示词预览」会把 `{{cwd}}` 原样显示出来，实际装配却抛错或替换 —— 预览里看到的并不是真正会生效的内容。插件不使用任何宿主提示词变量，因此关闭插值的代价为 0（需要上下文时，section 的 `text` 本身就是 `(context) => string` provider）。

### 4.4 配置损坏 →「人设像是被重置了」

**症状**：设置页里昵称 / 风格 / 预设库全空，像是被重置；或者保存时看到

```text
配置文件不是合法的 JSON（…）。（原文件已备份到 …\soul-config.json.corrupt）。
为避免覆盖，本次保存已拒绝；请修复或删除 …\soul-config.json 后重试。
```

**根因**：`soul-config.json` 被写坏（写盘中途进程被杀、磁盘满、手工编辑出错）。**0.7.0 及更早**的读取逻辑会吞掉一切异常并静默回退默认值，同时把它写进内存缓存 —— 于是之后**任何一次保存**都会以「默认值」为底合并改动再写回磁盘，用户原有的自定义指令与预设库**被永久覆盖，且全程没有任何提示**。

**0.7.1 的三处修复**：

| 修复 | 作用 |
| --- | --- |
| 写入改为「临时文件 + `rename` 覆盖」 | 同目录 rename 是原子替换，中断只会残留一个 `.tmp`，不会再产生截断的 JSON |
| 读取区分「文件不存在」与「文件损坏」 | 不存在 → 回退默认值、允许保存（首次运行的正常路径）；损坏 → 回退默认值以维持插件可用，但**拒绝任何写入** |
| 损坏文件自动另存 `soul-config.json.corrupt`，并在设置页上报 | 原内容可找回；用户不必自己猜「为什么人设没了」 |

**处理**：

| 情形 | 做法 |
| --- | --- |
| 想沿用旧配置 | 打开 `soul-config.json.corrupt`，把内容修正为合法 JSON（常见问题是缺一个 `}` 或末尾多一个逗号），另存回 `soul-config.json`，再刷新设置页 —— 读取会在下一次请求自动恢复，**不必重启 DSH** |
| 不需要旧配置 | 直接删除 `soul-config.json`，然后正常保存即可（文件不存在是允许写入的正常路径） |
| 只想临时回到默认 | 设置页「重置为默认值」（注意该操作会覆盖当前文件，前提是文件本身可解析） |

> 同目录下可能出现的两个辅助文件：`soul-config.json.tmp`（原子写的中间态，正常情况下会被 rename 吃掉，只在中断后残留）与 `soul-config.json.corrupt`（损坏内容的备份）。两者都可安全删除。

### 4.5 配置保存了，但 Agent 行为没变（0.7.1 起）

**症状**：设置页显示「已保存」，但当前会话的下一轮回复仍沿用旧风格 / 旧昵称 / 旧语言。

**先排除误判**：光轨四项（`trail*`）属纯外观配置，保存后本就不会改变系统提示词（见第三节 4) 的说明）。

**逐项排查（按发生概率排序）**：

| 检查 | 做法 | 说明 |
| --- | --- | --- |
| 保存其实被拒绝了 | 看设置页是否有红色横幅，或直接读 `$DSH_HOME/soul-config.json` | 配置损坏时写入会被有意拦下（见 4.4），界面会显示原因 |
| 跑的是旧副本 / 旧版本 | 见第三节 2) 版本核对 | `file:` 安装不会自动更新，改源码后必须 `remove` + `add` |
| 宿主不再每步重新求值 | `npm run verify:host` | 0.7.1 起「新配置生效」完全依赖宿主「每步重新装配 + 对函数式 `text` 不做缓存」。该脚本直接跑宿主的**真实实现**来判定；若它失败，说明 DSH 行为已变，需改回「主动刷新」思路（即 0.7.0 的做法：除注册 section 外，再 `agent.inject()` 一条快照） |

> 0.7.1 之前这条链路有第二重保险：插件会向所有活动会话 `agent.inject()` 一条配置快照。移除它的理由见 README「实现原理」；`npm run verify:host` 与 `npm run verify:e2e` 正是为替代这重保险而加的自动化护栏。

## 五、配置文件与日志

配置文件位于：

```text
$DSH_HOME/soul-config.json
```

未设置 `DSH_HOME` 时，使用 DSH 默认用户数据目录。

写入是**原子**的（先写同目录 `.tmp`、再 `rename` 覆盖），因此不存在"写到一半的半个配置文件"；读取失败时也不会把坏文件覆盖掉（见 4.4）。

日志：插件默认不输出运行日志。如需临时调试，可在源码中取消相关 `console` 语句的注释；宿主端输出到启动 DSH 的终端，客户端输出到浏览器 DevTools Console。调试完成后建议恢复注释。

## 六、实测环境备注

- `DSH_HOME` 未设置 → 基准目录 `%USERPROFILE%\.dsh`，profile 目录 `%USERPROFILE%\.dsh\profiles\<profile 名>`。
- 若 profile 的 `pnpm-workspace.yaml` 使用 `nodeLinker: hoisted`（扁平化 `node_modules`），这是 `link:` 行为异常的前提条件之一。
- `node_modules/.pnpm` 目录可能存在，但走扁平布局时，排查应以 `node_modules/<包名>` 为准。
