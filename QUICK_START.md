# 快速开始

## 安装

```bash
dsh plugin --profile <profile> add dsh-soul
```

启动 DSH 后，在设置页面打开「个性化设置」。

## 配置

可设置：

- 是否启用个性化设置
- 用户昵称
- 回复风格
- 语调
- 自定义指令

保存后，最新配置会同步到活动 Agent，并在下一次请求中生效。

## 斜杠命令

```text
/soul show
/soul reset
/soul enable
/soul disable
/soul <昵称>
```

## 配置文件

配置保存在 DSH 的用户数据目录：

```text
$DSH_HOME/soul-config.json
```

未设置 `DSH_HOME` 时使用 DSH 默认目录。
