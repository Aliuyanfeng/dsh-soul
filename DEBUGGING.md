# 故障排查与本地调试

## 一、安装 / 卸载 / 查看

`dsh plugin` 是一个 **pnpm 转发器**：它先在 profile 目录里执行 `pnpm <你的参数>`，成功后把 `dsh.profile.bundles` 与"实际安装结果"做一次调和——凡是解析得到、且声明了 `dsh.bundle.patch` 的依赖会被追加进 bundles 层栈；被移除或已不含该声明的依赖会从层栈中摘除。因此 `remove` 之后**不需要手工改 `package.json` 里的 bundles 列表**。

```bash
# 安装（registry 版本）
dsh plugin --profile <profile> add dsh-soul

# 安装（本地目录：file: 语义，会把包复制进 profile，见第二节）
dsh plugin --profile <profile> add ./dsh-soul
dsh plugin --profile <profile> add file:<插件源码绝对路径>

# 查看已装（转发给 pnpm）
dsh plugin --profile <profile> list

# 升级
dsh plugin --profile <profile> update dsh-soul

# 卸载
dsh plugin --profile <profile> remove dsh-soul
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
| A. 每次重装副本 | `dsh plugin --profile <profile> remove dsh-soul` → `add file:<绝对路径>` | 需**先 remove 再 add** + 重启宿主 + 硬刷新 | 最稳，但每次改动都要重来；**只 `add` 不会更新**，见下方 2.1 |
| B. `link:` 协议 | `dsh plugin --profile <profile> add link:<绝对路径>` | 软链直指源码，预期即时生效 | **Windows 上不可靠，见下方警告** |
| C. 目录联接 | 用 `mklink /J` 手工替换 `node_modules/dsh-soul` | 即时生效 | 绕过 pnpm，后续 install 可能清理掉联接 |

### 2.1 为什么只 `add` 不会更新（实测）

`file:` 依赖在 pnpm 的 lockfile 里**按路径登记**，pnpm 不比对目录内容。源码改了、路径没变 ⇒ 直接判定"已是最新"，副本**原地不动**。

实测（副本停在 0.6.0、源码已到 0.6.2）：

```text
dsh plugin --profile <profile> add file:<绝对路径>
→ Already up to date        # 没有任何报错，也没有任何警告提示你没装上
→ node_modules/dsh-soul 仍是 0.6.0
→ 并且继续按旧 package.json 报 peer 不兼容
```

**正确做法是「先移除、再安装」**——输出里出现 `Packages: +1` 才是真的装了：

```bash
dsh plugin --profile <profile> remove dsh-soul
dsh plugin --profile <profile> add file:<绝对路径>
```

装完务必核对副本版本，这是最容易踩空的一步：

```powershell
(Get-Content "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-soul\package.json" | ConvertFrom-Json).version
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
$prof = "$env:USERPROFILE\.dsh\profiles\<profile>"
$src  = "<插件源码绝对路径>"

# 1) 备份原副本（可回滚）
Rename-Item "$prof\node_modules\dsh-soul" "dsh-soul.bak"

# 2) 建立联接，指向源码目录（无需管理员权限）
cmd /c mklink /J "$prof\node_modules\dsh-soul" "$src"
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
dsh --profile desktop --dump-config
```

输出中应能看到 `soul` 这一行（`name: dsh-soul`），说明 patch 已正确合入配置树。包名写错会在这一步暴露为 `Cannot find package`。

### 2) 版本核对（确认跑的是不是你的源码）

```powershell
# 已装副本的版本号（桌面版用 desktop；Web 版换成 web）
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-soul\package.json" | ConvertFrom-Json).version

# 若用联接：Target 应输出源码绝对路径，而不是空白
(Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-soul").Target
```

`package.json` 的 `version`、`client/index.mjs` 的 `VERSION` 常量、`RELEASE_NOTES.md` 三处应一致（本版均为 `0.7.1`）。

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

### 3.5) 「保存了却不生效」——两条通道与对应回归

「保存配置 → 当前会话下一轮就用上新配置」由**两条独立通道**共同保证，**缺一不可**：

| 通道 | 机制 | 对应回归 | 失败症状 |
| --- | --- | --- | --- |
| ① system prompt section | 宿主每个 step 都重新装配提示词，对函数式 `text` provider **不做缓存**；文本变化时自行提交新的 system 快照 | `npm run verify:host` | 改配置后下一轮完全没变化 |
| ② 活动会话注入 | 保存后 `refreshPromptAndInject()` 遍历 `agents.list()`，用 `agent.inject()` 把最新快照推给每个活动会话 | `npm run verify:e2e` | 同上，但会话里也看不到 `[dsh-soul 个性化配置已更新]` |

**本版（0.7.1）的教训**：开发中曾一度只保留通道 ①（删掉注入与 `lib/injection.mjs`），理由是「宿主每步重算 ⇒ 注入冗余」。实测该推理**不成立** —— **会话进行中修改人设不会在下一轮生效**。`verify:host` 20 项全绿也只证明「宿主每次装配都会重新求值」这一层成立，**不等于**端到端一定生效。因此注入是必需的第二条通道，**不要单独删除**。

排查顺序：

1. 确认保存真的成功 —— 设置页没有错误横幅、`soul-config.json` 已更新、`POST /api/soul/config` 返回 `changed` 非空；
2. 发一条**新消息**再观察（两条通道都只在下一次请求生效，不会打断正在进行的回复）；
3. 看会话流里有没有 `[dsh-soul 个性化配置已更新]`（通道 ② 的可见载体，user 角色）；纯外观字段（输入框光轨）**不会**产生它，这是预期行为；
4. **直接问插件自己**（0.7.1 起，此前这类失败是全静默的）：
   - `/soul show` 末尾的「送达」一行 —— 显示活动会话数、成功注入数与异常原因；
   - `curl.exe -s http://127.0.0.1:3080/api/soul/status` —— 两条通道的状态、配置路径与版本号；
   - 设置页的提示条：`configError`（配置**读不出来**）与 `deliveryWarning`（配置**送不到会话**）是两种问题、两种处理方式；
   - 插件日志：同一个原因只会打印一次（`ctx.logger`），恢复正常后允许再次打印。
5. 仍不生效时跑 `npm run verify:e2e` / `npm run verify:host` 定位断在哪一层 —— 前者失败说明插件侧（保存或注入），后者失败说明宿主行为已变（DSH 升级后尤其要跑一次）。

> `verify:host` 验证的是**哪一份宿主**由锚点顺序决定，且会打印出来：优先「装了本插件的 profile」，并在解析到多份 DSH 副本时逐一列出。若你的机器上装着多份 DSH（例如 `~/.dsh/profiles/*` 之外还有一个全局安装），不要用 `--dsh` 指错目录——脚本会直接报错而不是悄悄换一份实现去验证。

### 3.6) `npm run verify` 里的「跳过」与「假绿」

`npm run verify` 串了 **8 个脚本**，按「由浅入深」四层排列：

| 层 | 脚本 | 断言数 | 会不会跳过 |
| --- | --- | --- | --- |
| 纯函数 / 契约 | `verify-config` | 91 | 否（本机未装 DSH 时，set_persona 的行为层那 1 项跳过） |
| 持久化行为 | `verify-store` | 18 | 仅 1 项（平台不提供 inode 时） |
| 客户端行为 | `verify-client` | 17 | 否 |
| 端到端（保存 → 两条通道都拿到新文本） | `verify-e2e-prompt` | 38 | 否 |
| 宿主实现 | `verify-live-prompt` | 20 | 定位不到 DSH 时整脚本跳过 |
| 版本兼容 | `verify-compat` | 10（声明数；未执行项按 `skipNote` 从声明数里下修后对账） | 定位不到 DSH 时整脚本跳过 |
| 渲染层 | `verify-trail` | 11 | 起不来浏览器时整脚本跳过 |
| 渲染层 | `verify-nav-icon` | 16（含 6 项判断力自检） | 同上 |

也可以单跑一层：`npm run verify:store` / `verify:client` / `verify:e2e` / `verify:host` / `verify:compat` / `verify:trail` / `verify:nav-icon`。

**跳过也是退出码 0** —— 所以整条链看起来一片绿，实际可能少了 50+ 项断言。0.7.1 起：

- 跳过会显式打印「本次有 N 项断言**未执行**。跳过不等于通过。」，并给出补跑方式；
- 需要「跳过即失败」时用 `npm run verify:strict`（链上每一项都带 `--strict`）；
- 每个脚本跑完时会校验实际断言数与脚本里声明的 `EXPECTED_ASSERTIONS` 一致 —— 断言数对不上说明本次运行不可信，会直接判失败（这比数字悄悄变成谎话好）；
- 两种跳过的分工：**整个脚本**跑不了用 `skipExit`（直接结束进程）；**脚本内某一项**跑不了用 `skipNote`（其余断言照跑，该项不计入声明数，并在 `--strict` 下判失败）。`skipNote` 是为 `verify-store` 的 inode 探测加的 —— 各平台上 `stat.ino` 的可用性不同，不该让整脚本陪葬；
- 断言数自校验自己也有回归守着：`verify-config` 会逐个读链上脚本的源文本，要求它**真正 `import` 了 `./lib/skip-report.mjs`**（只在注释里出现不算）、**把断言数交给了 skip-report**（`assertCount` 精确校验，或 `NOMINAL_ASSERTIONS` 供 `skipExit` 报告）、且**不得自己解析 `--strict`**（否则两处判定会漂移）。这三条都是「判断力对照」逼出来的 —— 注释替身、装饰性 `--strict` 都曾真的骗过更宽松的写法。

### 3.7) 客户端行为怎么离线验证（`verify-client`）

`verify-trail` / `verify-nav-icon` 覆盖的是**渲染层**（DOM 里的 SVG），而设置页的**交互行为**此前只有「源文本契约」——即断言 `client/index.mjs` 里出现了某段写法。那种断言证明不了运行时真的走了那条分支：把 `if (!payload)` 改成常量、或让 `resetConfig` 永不返回 `undefined`，源码看起来依然正确。

`verify-client` 把**真实的 `client/index.mjs` 原样载入**（不复制、不裁剪），在纯 Node 里用一小撮 React 垫片 + 假 `window` / `document` / `fetch` / 定时器跑真实的 `apply(ctx)`，然后**像用户一样点按钮**，断言**用户实际会看到的那句提示**。它守着 0.7.1 修过、而此前没有行为回归看护的四处：

| 用例 | 守的是什么 |
| --- | --- |
| C1 / C2 / C12 | 装配、注册 `settings.section`、装配后立即 GET 拉配置、设置页真的渲染出可点的按钮与字段（防「空树也通过」） |
| C3 / C4 / C5 | `configError`（读不出来）与 `deliveryWarning`（送不到会话）都要可见，且两者同在时**前者优先** |
| C6 / C7 | 保存成功带回的 `deliveryWarning` 要落到提示条；保存失败必须返回 falsy |
| C8 | 重置失败**不得**报成成功（配置损坏时那唯一一条自救路径） |
| C9 / C10 | 重置丢弃过损坏文件时要提示「已备份」；普通重置不留残余警告 |
| C11 | 保存失败**不得**误报成「配置无变化」 |

两个实现要点（离线复刻时踩过的坑）：

- 必须接管 `setInterval`，不只是 `setTimeout` —— 设置页「关于你」分组每 2s 轮询刷新，不接管则事件循环永不空，脚本打印完最后一行却不退出（看起来像挂住）；
- `fetch` 桩要能表达「HTTP 200 但 `payload.ok === false`」这种失败形态，因为 `postJSON` 正是按 `!response.ok || payload.ok !== true` 判失败的。

无浏览器时的补跑（两段式，本机 sandbox 常拦子进程，此路必用）：

```powershell
node scripts/verify-trail.mjs --emit "$env:TEMP\trail.html"
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-sandbox `
  --user-data-dir="$env:TEMP\chrome-trail-profile" --virtual-time-budget=8000 `
  --allow-file-access-from-files --dump-dom "file:///$env:TEMP\trail.html" > "$env:TEMP\trail-dump.html"
node scripts/verify-trail.mjs --dump "$env:TEMP\trail-dump.html"
```

`verify-nav-icon` 同理（`--emit` / `--dump`，无须 `--allow-file-access-from-files`）。

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
| 不污染提示词 | 只改光轨颜色 → 仅提示「已保存」，**不产生**会话注入消息；改昵称 / 风格才会注入 |

> 光轨四项属于**纯外观配置**：计入"配置已变更"（用于保存提示与脏检查），但被排除在 `promptChanged` 之外，因此既不刷新系统提示词，也不向会话注入快照。

## 四、常见报错

| 报错 / 症状 | 原因 | 解决 |
| --- | --- | --- |
| `dsh-soul@x.y.z 与 DSH a.b.c 不兼容（要求 …）` | 插件声明的 peer 范围不含当前 DSH 运行时版本 | 见下方 4.1 |
| `Cannot find package 'dsh-soul' imported from …\profiles\<profile>\` | 配置树里有插件行，但包没进 `node_modules` | 先 `dsh plugin add`，再启动 |
| 插件目录存在但为空 | `link:` 在无开发者模式的 Windows 上静默退化成空目录 | 改用 `mklink /J` 联接 |
| 设置栏目不显示 | 插件没装进当前 profile / DSH 未完全重启 / 页面没刷新 | 重装 → 重启 → 硬刷新 |
| 动效完全不出现 | 开关关闭 / Agent 未处于回复中 / `prefers-reduced-motion` 生效 | 逐项核对 |
| 输入框卡片高度不断变大、聊天区出现巨大空白（开着光轨时） | 光轨的 SVG 退回了常规流，形成尺寸正反馈 | 见下方 4.2；0.6.2 起已内置三层隔离与熔断 |
| 改源码后无反应 | 装的是复制副本 | 见第二节方案 C |
| `dsh web --patch ./x.yml` 报 `web takes none of …` | `web` 别名命令不接受全局选项 | 写全称 `dsh --profile <profile> --patch …` |
| 配置保存了但 Agent 行为没变 | `agent.inject()` 只在下一次模型请求生效 | 先发一条新消息再观察 |
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

1. 只校验名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer；**`@deepseek-ai/cordis` 不参与判定**（所以报错只列 dsh-llm 与 dsh-tools）；
2. 被比较的一方是 **DSH 运行时版本**（`dsh-app-boot/package.json` 的 version），不是这两个包各自的版本；
3. 判定式 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。`^0.1.1-rc.2` 的隐含上界是 `<0.2.0-0`，所以它会挡住整条 0.2.x 线。

**先确认是不是纯声明问题**：

```bash
npm run verify:compat                 # 自动定位本机 DSH
node scripts/verify-compat.mjs --dsh "<DSH 安装目录>"
node scripts/verify-compat.mjs --runtime 0.2.0-rc.2
```

输出会逐条给出「通过 / 不通过」，并标注判定方式（能取到宿主时会直接调用 DSH 的原生函数）。脚本末尾还会抽查 `createUserMessage` / `defineTool` / `TOOL_RUNTIME_SCHEDULER` 与客户端 `inject` 包——这一层 DSH 不校验：

- 只有 peer 不通过、符号齐备 → 属**声明过期**，升级插件即可；
- 同时报符号缺失 → **代码也需要适配**，不能只改版本范围。

**三种处理方式**：

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| 升级插件（推荐） | `dsh plugin --profile <profile> update dsh-soul` | 上游已发布声明兼容的版本 |
| 临时豁免 | `dsh plugin --profile <profile> allow-version dsh-soul@0.6.0 --dsh-version 0.2.0-rc.2 --accept-risk` | 上游尚未发版，需先跑起来 |
| 参与修复 | 放宽 `peerDependencies` 上界并升版本发版 | 你是维护者（见 `PUBLISHING.md`） |

豁免查询与撤销：

```bash
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> revoke-version dsh-soul@0.6.0 --dsh-version 0.2.0-rc.2
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

> 修复的附加收益：预览与真实注入**逐字符一致**。0.7.0 时「提示词预览」会把 `{{cwd}}` 原样显示出来，实际注入却抛错或替换 —— 预览里看到的并不是真正会生效的内容。插件不使用任何宿主提示词变量，因此关闭插值的代价为 0（需要上下文时，section 的 `text` 本身就是 `(context) => string` provider）。

### 4.4 配置损坏 →「人设像是被重置了」

**症状**：设置页里昵称 / 风格 / 预设库全空，像是被重置；或者保存时看到

```text
配置文件不是合法的 JSON（…）。（原文件已备份到 …\soul-config.json.corrupt）。
为避免覆盖，本次保存已拒绝；请修复或删除 …\soul-config.json 后重试。
```

**根因**：`soul-config.json` 被写坏（写盘中途进程被杀、磁盘满、手工编辑出错）。**0.7.0 及更早**的读取逻辑会吞掉一切异常并静默回退默认值，同时把它写进内存缓存 —— 于是之后**任何一次保存**都会以「默认值」为底合并改动再写回磁盘，用户原有的自定义指令与预设库**被永久覆盖，且全程没有任何提示**。

**0.7.1 的四处修复**：

| 修复 | 作用 |
| --- | --- |
| 写入改为「临时文件 + `rename` 覆盖」 | 同目录 rename 是原子替换，中断只会残留一个 `.tmp`，不会再产生截断的 JSON |
| 读取区分「文件不存在」与「文件损坏」 | 不存在 → 回退默认值、允许保存（首次运行的正常路径）；损坏 → 回退默认值以维持插件可用，但**拒绝任何写入** |
| 损坏文件自动另存 `soul-config.json.corrupt`，并在设置页上报 | 原内容可找回；用户不必自己猜「为什么人设没了」 |
| **「重置」成为逃生口** | 拒绝写入如果没有出口，用户就只能自己删文件。重置被定义为**刻意丢弃**：先把损坏文件移开（＝备份为 `.corrupt`），再写入默认值。它与「不静默覆盖」不冲突——静默覆盖仍被禁止，重置则是用户显式发起、且覆盖前留备份 |

**处理**：

| 情形 | 做法 |
| --- | --- |
| 想沿用旧配置 | 打开 `soul-config.json.corrupt`，把内容修正为合法 JSON（常见问题是缺一个 `}` 或末尾多一个逗号），另存回 `soul-config.json`，再刷新设置页 —— 读取会在下一次请求自动恢复，**不必重启 DSH** |
| 不需要旧配置 | 直接用设置页的**「重置为默认」** —— 损坏状态下这是唯一还能成功的写操作，它会自动把损坏文件备份为 `.corrupt`；也可以手动删除 `soul-config.json`，然后正常保存 |
| 想确认备份去了哪 | `/soul reset` 会回报备份路径，设置页重置成功的提示也会说明「已备份」 |

> 同目录下可能出现的两个辅助文件：`soul-config.json.tmp`（原子写的中间态，正常情况下会被 rename 吃掉，只在中断后残留）与 `soul-config.json.corrupt`（损坏内容的备份）。两者都可安全删除。

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
