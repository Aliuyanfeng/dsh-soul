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

仓库已配置 `.github/workflows/publish.yml`：推送 `v*` 格式的 tag 时自动发布到 npm。

发布使用 **OIDC 可信发布**（Trusted Publishing），CI 无需保存任何 token。首次使用需在 npmjs.com 配置一次：

1. 打开 `https://www.npmjs.com/package/dsh-soul` → `Settings` → 「Trusted publishing」。
2. 选择 **GitHub Actions**，填写：

   | 字段 | 值 |
   |---|---|
   | Organization or user | `Aliuyanfeng` |
   | Repository | `dsh-soul` |
   | Workflow filename | `publish.yml` |
   | Environment name | 留空 |
   | Allowed actions | 勾选 `npm publish` |

3. 保存。

> npm 保存时不会校验这些字段，填错只会在真正发布时报 `ENEEDAUTH`。字段名区分大小写，需与仓库完全一致。

之后发布流程：

```bash
# 1. 更新版本号（遵循语义化版本）
npm version patch   # 或 minor / major

# 2. 推送提交和 tag
git push && git push --tags
```

`npm version` 会自动修改 `package.json` 的版本号并创建对应的 git tag。工作流会校验 tag 版本号与 `package.json` 一致，不一致则发布失败。

推送 tag 后可在 GitHub 仓库的 `Actions` 标签页查看发布进度。

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
