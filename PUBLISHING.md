# 发布说明

## 发布前检查

确认 `package.json` 包含：

- `name`
- `version`
- `main`
- `dsh.bundle.patch`
- `files`

发布包至少应包含（当前 19 个文件）：

```text
index.mjs
lib/*.mjs                      # config / injection / personas / store
client/index.mjs
assets/icon.svg
cordis.patch.yml
scripts/lib/skip-report.mjs
scripts/verify-*.mjs           # config / store / e2e-prompt / live-prompt / compat / trail / nav-icon
README.md
README_EN.md
package.json
```

使用以下命令检查包内容：

```bash
npm pack --dry-run
```

发版前先跑一遍回归：`npm run verify`（全部通过时 rc=0）。若环境缺浏览器 / DSH 运行时，部分脚本会**显式跳过并以 rc=0 通过**——要求「跳过即失败」时改用 `npm run verify:strict`（链上每项都带 `--strict`，无浏览器时会失败，属预期）。

## 发布

### 自动发布（推荐）

仓库已配置 `.github/workflows/publish.yml`：**在 GitHub 上发布 Release 时自动发布到 npm**。tag 由 GitHub 在发布 Release 时自动创建，本地无需手动打 tag。

发布使用 **OIDC 可信发布**（Trusted Publishing），CI 无需保存任何 token。首次使用需在 npmjs.com 配置一次：

1. 打开 `https://www.npmjs.com/package/dsh-soul` → `Settings` → 「Trusted publishing」。
2. 选择 **GitHub Actions**，填写：

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `Aliuyanfeng` |
   | Repository | `dsh-soul` |
   | Workflow filename | `publish.yml` |
   | Environment name | 留空 |
   | Allowed actions | 勾选 `npm publish` |

3. 保存。

> npm 保存时不会校验这些字段，填错只会在真正发布时报 `ENEEDAUTH`。字段名区分大小写，需与仓库完全一致。

#### 发版流程

#### 第一步：本地更新版本号并推送

```bash
# 1. 更新版本号（遵循语义化版本；--no-git-tag-version 只改 package.json，不 commit 不打 tag）
npm version patch --no-git-tag-version   # 或 minor / major

# 2. 提交并推送（版本号 commit 也可以和其他改动合并提交）
git add package.json
git commit -m "chore: release v0.2.1"
git push origin main
```

#### 第二步：GitHub 网页创建 Release

1. 仓库页 → **Releases** → **Draft a new release**。
2. **Choose a tag** 输入 `0.2.1`（与 `package.json` 版本一致，**不带 `v` 前缀**）→ 选择 **Create new tag on publish**（基于 main 最新 commit）。
3. Release 标题填 `v0.2.1`（标题惯例带 `v`，与 tag 名不同，这是仓库既有实践）；描述从 `RELEASE_NOTES.md` 复制对应版本段落。
4. 点击 **Publish release** → GitHub 创建 tag 并触发工作流 → 自动发布到 npm。

> **tag 命名约定**：仓库全部历史 tag 均为不带 `v` 的形式（`0.1.1`、`0.3.0` … `0.6.0`），而 Release **标题**惯例带 `v`。工作流用 `TAG_VERSION="${GITHUB_REF_NAME#v}"` 校验，所以两种写法都能通过校验，但混用会造成 tag 命名不一致，不建议。

工作流执行内容：校验 tag 版本号与 `package.json` 一致（不一致直接失败，仅 Release 触发时执行）→ `npm pack --dry-run` 检查包内容 → 幂等检查（npm 上已存在同版本则置 `already=true`）→ `npm publish`（由 `if` 门控，已发布时整步跳过，避免 403；OIDC，自动生成溯源证明）。

> **工作流文件取自 tag 所指向的 commit**，而不是默认分支的最新版本。因此若 tag 指向的 commit 早于某次工作流修复，该次发布仍会执行旧版工作流。发版前请确认 tag 基于最新 main 创建（选择 *Create new tag on publish* 且目标为 `main`）。

> 幂等检查依赖**步骤输出**而非 `exit 0`：`run` 中的 `exit 0` 只结束当前步骤，无法阻止后续步骤执行，必须将结果写入 `$GITHUB_OUTPUT`，再由 `Publish` 步骤用 `if:` 判断。

可在仓库 **Actions** 标签页查看发布进度。

> 注意：Draft（草稿）状态的 Release 不会触发发布，必须点击 Publish release。

#### 手动触发（workflow_dispatch）

工作流同时支持 `workflow_dispatch`：仓库 → **Actions** → 左侧选 **Publish to npm** → **Run workflow**，选择分支后运行。

此时不存在 tag，因此 **tag 校验步骤会被跳过**，发布版本直接取当前分支 `package.json` 的 `version`，幂等检查照常生效。适用于补发、或在 Release 流程出问题时的应急发布。

```text
release 事件      : tag 校验 -> 包内容检查 -> 幂等检查 -> (未发布时) publish
workflow_dispatch : 跳过     -> 包内容检查 -> 幂等检查 -> (未发布时) publish
```

#### 同步维护 RELEASE_NOTES.md

`RELEASE_NOTES.md` 是发版说明的单一来源：发版前先把该版本的变更写入（或确认已写入）`RELEASE_NOTES.md`，再粘贴到 GitHub Release 描述中，保持两处一致。

### 手动发布

```bash
npm login
npm publish --access public
```

后续发布必须更新版本号，并遵循语义化版本规则。

手动发布需要 2FA。若账号启用了 2FA，需改用 Granular Access Token：

1. npmjs.com → 头像 → `Access Tokens` → `Generate New Token`。
2. **Bypass two-factor authentication**：勾选。
3. **Packages and scopes**：权限选 `Read and write`，选择 `Only select packages and scopes`，只添加 `dsh-soul`。
4. **Expiration**：按需选择，最长 90 天。
5. 生成后 `npm config set //registry.npmjs.org/:_authToken=<token>`。

> npm 已于 2025 年 11 月移除 Classic Token（含原 Automation 类型），目前只能创建 Granular Access Token，且最长有效期 90 天，需定期轮换。CI 中请优先使用上面的 OIDC 可信发布，避免轮换负担。

## 依赖与 DSH 兼容性

插件不打包任何 DSH 运行时包，全部声明为 `peerDependencies` 交由宿主提供：

| 包 | 范围 | DSH 是否校验 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `>=0.1.1-rc.2 <0.3.0-0` | 是 |
| `@deepseek-ai/dsh-tools` | `>=0.1.0-rc.6 <0.3.0-0` | 是 |
| `@deepseek-ai/cordis` | `^4.0.1 \|\| ^4.0.5-alpha.1` | 否 |

### DSH 如何判定（决定范围该怎么写）

`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 是唯一权威实现，规则有三条：

1. **只校验**名字为 `@deepseek-ai/dsh`、或以 `@deepseek-ai/dsh-` 开头的 peer；其余（如 `@deepseek-ai/cordis`）不参与判定；
2. 被比较的一方是 **DSH 运行时版本**（`dsh-app-boot/package.json` 的 `version`），**不是**该 peer 包自己的版本；
3. 判定式为 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。

第 3 点有两个容易踩的后果：

- `^0.1.1-rc.2` 的隐含上界是 `<0.2.0-0`，因此**挡不住** 0.2.x 线——这正是 v0.6.0 在 DSH 0.2.x 上被拒绝装载的原因；
- 当运行时是 prerelease 时，range 必须**显式覆盖它的 `major.minor.patch`**：`>=0.1.1-rc.2 <0.3.0-0` 能匹配 `0.2.0-rc.2` 与 `0.2.1-alpha.1`，而 `>=0.1.1-rc.2` 不能匹配 `0.2.0-rc.2`。

因此推荐写成 `>=<最低支持版本> <下一条线>-0`：既覆盖当前全部 prerelease，又在下一条线到来时主动失败、提醒重新评估。

### DSH 升级后的维护流程

```bash
npm run verify:compat
# 或指定版本 / 安装目录
node scripts/verify-compat.mjs --runtime 0.2.0-rc.2
node scripts/verify-compat.mjs --dsh "<DSH 安装目录>"
```

- **通过** → 无需改动；
- **不通过** → 放宽上界（或按实际支持的范围重写）、升 `version`，再按正常流程发版。

脚本在能定位到宿主时，会直接调用 DSH 导出的 `evaluatePluginCompatibility`，判定与宿主逐字一致；此外还会抽查 `createUserMessage` / `defineTool` / `TOOL_RUNTIME_SCHEDULER` 等运行时符号与客户端 `inject` 包是否仍在——**peer 检查覆盖不到这一层**，若报符号缺失，说明不只是声明过期，插件代码也需要适配。

### 应急：临时版本豁免

用户侧若要在插件发新版前强行装载，DSH 提供按「精确包版本 + 精确 DSH 版本」的豁免（写入 profile 的 `compatibility.json`，需显式接受风险）：

```bash
dsh plugin --profile <profile> allow-version dsh-soul@0.6.0 --dsh-version 0.2.0-rc.2 --accept-risk
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> revoke-version dsh-soul@0.6.0 --dsh-version 0.2.0-rc.2
```

> 豁免只对写明的那个组合生效，任一侧升级后即失效。

不要在源码、文档或发布包中包含 token、密钥、个人配置或本地路径。
