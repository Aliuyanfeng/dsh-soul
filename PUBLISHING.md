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
package.json
```

使用以下命令检查包内容：

```bash
npm pack --dry-run
```

## 发布

登录 npm 后发布公开包：

```bash
npm login
npm publish --access public
```

后续发布必须更新版本号，并遵循语义化版本规则。

## 依赖

插件运行需要宿主环境提供兼容版本的：

- `@deepseek-ai/cordis`
- `@deepseek-ai/dsh-llm`

不要在源码、文档或发布包中包含 token、密钥、个人配置或本地路径。
