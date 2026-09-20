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
| A. 每次重装副本 | `dsh plugin --profile web add file:<绝对路径>` | 需**重新执行 add** + 重启宿主 + 硬刷新 | 最稳，但每次改动都要重来 |
| B. `link:` 协议 | `dsh plugin --profile web add link:<绝对路径>` | 软链直指源码，预期即时生效 | **Windows 上不可靠，见下方警告** |
| C. 目录联接 | 用 `mklink /J` 手工替换 `node_modules/dsh-soul` | 即时生效 | 绕过 pnpm，后续 install 可能清理掉联接 |

### ⚠️ 关于方案 B（`link:`）的 Windows 警告

本机实测（pnpm 11.22.0 / Node 22.22.2 / 该 profile 使用 `nodeLinker: hoisted`）：

- pnpm 的 `link:` 走 `fs.symlinkSync(..., 'dir')`，即**目录符号链接**；
- Windows 上创建目录符号链接需要**开发者模式**或管理员权限。权限不足时，实测结果是**静默退化成一个空目录**：`readlinkSync` 报 `EINVAL`、`lstat().ino === stat().ino`、`readdir` 返回空；
- 后果比"改源码不生效"更糟：插件目录里**什么都没有**，DSH 会因找不到 `index.mjs` 而直接加载失败。

对照验证：`fs.symlinkSync(..., 'junction')` 与 `cmd /c mklink /J` 在**不需要任何特权**的前提下均正常工作（`readlinkSync` 可解析、内容可读）。所以本机应选**联接**，而非符号链接。

执行 `link:` 之前先确认「设置 → 系统 → 开发者选项 → 开发者模式」是否已开启；开启后 `link:` 才可信。

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
| 宿主端 `index.mjs` / `lib/config.mjs` | **完全重启 DSH**（Node 进程需重新 import） |
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

`package.json` 的 `version`、`client/index.mjs` 的 `VERSION` 常量、`RELEASE_NOTES.md` 三处应一致（本版均为 `0.6.0`）。

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
| 不污染提示词 | 只改光轨颜色 → 仅提示「已保存」，**不产生**会话注入消息；改昵称 / 风格才会注入 |

> 光轨四项属于**纯外观配置**：计入"配置已变更"（用于保存提示与脏检查），但被排除在 `promptChanged` 之外，因此既不刷新系统提示词，也不向会话注入快照。

## 四、常见报错

| 报错 / 症状 | 原因 | 解决 |
| --- | --- | --- |
| `Cannot find package 'dsh-soul' imported from …\profiles\web\` | 配置树里有插件行，但包没进 `node_modules` | 先 `dsh plugin add`，再启动 |
| 插件目录存在但为空 | `link:` 在无开发者模式的 Windows 上静默退化成空目录 | 改用 `mklink /J` 联接 |
| 设置栏目不显示 | 插件没装进当前 profile / DSH 未完全重启 / 页面没刷新 | 重装 → 重启 → 硬刷新 |
| 动效完全不出现 | 开关关闭 / Agent 未处于回复中 / `prefers-reduced-motion` 生效 | 逐项核对 |
| 改源码后无反应 | 装的是复制副本 | 见第二节方案 C |
| `dsh web --patch ./x.yml` 报 `web takes none of …` | `web` 别名命令不接受全局选项 | 写全称 `dsh --profile web --patch …` |
| 配置保存了但 Agent 行为没变 | `agent.inject()` 只在下一次模型请求生效 | 先发一条新消息再观察 |

## 五、配置文件与日志

配置文件位于：

```text
$DSH_HOME/soul-config.json
```

未设置 `DSH_HOME` 时，使用 DSH 默认用户数据目录。

日志：插件默认不输出运行日志。如需临时调试，可在源码中取消相关 `console` 语句的注释；宿主端输出到启动 DSH 的终端，客户端输出到浏览器 DevTools Console。调试完成后建议恢复注释。

## 六、实测环境备注

- `DSH_HOME` 未设置 → 基准目录 `%USERPROFILE%\.dsh`，profile 目录 `%USERPROFILE%\.dsh\profiles\<profile 名>`。
- 若 profile 的 `pnpm-workspace.yaml` 使用 `nodeLinker: hoisted`（扁平化 `node_modules`），这是 `link:` 行为异常的前提条件之一。
- `node_modules/.pnpm` 目录可能存在，但走扁平布局时，排查应以 `node_modules/<包名>` 为准。
