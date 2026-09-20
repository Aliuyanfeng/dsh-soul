# 发布说明

## 发布前检查

确认 `package.json` 包含：

- `name`
- `version`
- `main`
- `dsh.bundle.patch`
- `files`

发布包至少应包含：

```text
index.mjs
lib/config.mjs
client/index.mjs
cordis.patch.yml
README.md
README_EN.md
package.json
```

使用以下命令检查包内容：

```bash
npm pack --dry-run
```

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
2. **Choose a tag** 输入 `v0.2.1`（必须与 `package.json` 版本一致，带 `v` 前缀）→ 选择 **Create new tag on publish**（基于 main 最新 commit）。
3. Release 标题填 `v0.2.1`；描述从 `RELEASE_NOTES.md` 复制对应版本段落。
4. 点击 **Publish release** → GitHub 创建 tag 并触发工作流 → 自动发布到 npm。

工作流执行内容：校验 tag 版本号与 `package.json` 一致（不一致直接失败，仅 Release 触发时执行）→ `npm pack --dry-run` 检查包内容 → 幂等检查（npm 上已存在同版本则置 `already=true`）→ `npm publish`（由 `if` 门控，已发布时整步跳过，避免 403；OIDC，自动生成溯源证明）。

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

## 依赖

插件运行需要宿主环境提供兼容版本的：

- `@deepseek-ai/cordis`
- `@deepseek-ai/dsh-llm`

不要在源码、文档或发布包中包含 token、密钥、个人配置或本地路径。
