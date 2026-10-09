# 插件结构说明

`dsh-soul` 是一个 DSH bundle，通过 `cordis.patch.yml` 将插件加入 DSH 配置。

## 必要文件

```text
package.json
index.mjs
client/index.mjs
cordis.patch.yml
README.md
```

## Manifest

`package.json` 通过 `dsh.bundle.patch` 指向：

```text
cordis.patch.yml
```

patch 内容：

```yaml
- insert:
    - id: soul
      name: dsh-soul
```

## 运行组成

- `index.mjs`：注册配置服务、斜杠命令和 system prompt。
- `client/index.mjs`：注册 Web UI 设置栏目。
- `cordis.patch.yml`：声明插件在 DSH 中的加载项。

配置更新后，插件只需更新配置缓存：宿主在每一步都会重新装配系统提示词并重新求值 `soul:persona` section，下一次请求即生效，插件侧**不向会话注入任何消息**。
