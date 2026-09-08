# Codex、DeepSeek、GLM Coding Plan 接入

无需修改 Kindle 系统，可以先在电脑浏览器中验证采集结果。本项目查询账户用量和余额，不发起模型对话。

| 服务 | 显示内容 | 凭据 |
| --- | --- | --- |
| Codex | 接口返回的套餐用量周期，例如 5 小时、周额度；百分比为已使用 | 本机 Codex 的 ChatGPT 登录状态 |
| DeepSeek | API 账户余额，保留返回的人民币或美元币种 | DeepSeek 开放平台 API Key |
| GLM Coding Plan | 接口返回的 5 小时、周额度及 MCP 月额度；百分比为已使用 | 对应平台的 Coding Plan API Key |

未返回的额度周期和重置时间不会补造。Codex 仅通过 API Key 登录时可能没有 ChatGPT 套餐额度；DeepSeek 普通聊天账户没有可在这里查询的免费聊天次数。

## 本机配置

需要 Node.js 18+，不需要安装第三方依赖。首次使用时复制 `config.example.json` 为 `config.json`，复制 `.env.example` 为 `.env`；已有文件时直接编辑，不要覆盖原有配置。

在 `.env` 中填写：

```dotenv
DEEPSEEK_API_KEY=
GLM_API_KEY=
GLM_PLATFORM=bigmodel
```

密钥填在等号后；`bigmodel` 对应智谱国内站，国际 Z.ai 用户改为 `zai`。两边的账户和密钥不能混用。密钥可以分别在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 和 [智谱开放平台](https://open.bigmodel.cn/) 管理。

Codex 使用本机登录状态，不需要把登录令牌复制到这个文件。如果找不到 Codex 可执行程序，在 `.env` 的 `CODEX_CLI_PATH` 中填写程序的完整路径。已有系统环境变量优先于 `.env`；该文件只支持单行值，不执行变量展开或脚本。

默认 `config.json` 已启用这三家服务。缺少密钥显示“待配置”；网络请求失败时可以显示带“旧值”标记的最近成功结果。演示数据不会用作真实额度的失败回退。

## 查看和更新

先采集并生成页面：

```sh
npm run refresh
npm run serve
```

在电脑打开 [本地面板](http://127.0.0.1:8787)。另一个终端运行：

```sh
npm run watch
```

这个进程每 3 分钟采集并更新页面，每次重新读取 `.env`，保存密钥后下一轮即可生效。关闭进程或按 Ctrl+C 停止。它不会安装开机启动或系统定时任务；电脑需要保持运行和联网。网页独立每 3 分钟读取生成的数据，03:00–08:00 暂停网页刷新，因此保存密钥后也可以手动刷新页面提前查看。

只看布局可使用 `npm run demo` 后 `npm run build`，页面会标明“演示模式”。回到真实数据使用 `npm run refresh`。持续采集进程会覆盖演示快照。

本地预览默认只允许本机访问。让 Kindle 访问需要后续配置可达地址，并确认设备有可用浏览器；此阶段不需要越狱，也不会向 Kindle 写入文件。

### 在同一 Wi-Fi 的 Kindle 上打开

让电脑和 Kindle 连接同一 Wi-Fi。Windows 上另开一个 PowerShell 窗口，把 `DASHBOARD_HOST` 设置为电脑 WLAN 网卡的 IPv4 地址，再运行预览：

```powershell
$env:DASHBOARD_HOST = '电脑的 WLAN IPv4 地址'
npm run serve
```

在 Kindle 的浏览器地址栏输入 `http://电脑的 WLAN IPv4 地址:8787/`。电脑本机使用的 `127.0.0.1` 不能填到 Kindle 上。服务仅绑定所填网卡；若系统防火墙阻止访问，需要允许该局域网内设备访问这个服务端口。电脑更换网络或地址后，需要重启服务并使用新地址。咪咕版设备若没有浏览器入口，不能仅靠输入网址完成显示。

## 发布到 GitHub Pages

电脑先完成 GitHub 登录。`origin` 应指向自己的 Fork。运行 `npm run publish:pages` 会采集最新额度，在本地生成网页，并把六个必要的网页文件推送到 `gh-pages` 分支。代码分支和本地配置保持独立；发布端重新生成公开快照，去掉原始错误信息和额外账户字段，并检查是否包含本地密钥。

首次发布后，在仓库 Settings → Pages 中选择 Deploy from a branch、`gh-pages` 和 `/(root)`。网站地址通常为 `https://你的用户名.github.io/仓库名/`。后续推送会触发网页更新，GitHub 的构建和缓存可能带来几分钟延迟。

定期同步可由 Codex 当前任务的自动化调用同一条发布命令。自动化运行依赖这台电脑和 Codex 的可用状态；电脑离线时，网站保留上次发布结果。网页只有访问能力，不会自己读取电脑上的密钥或采集新用量。

发布用的独立目录和锁文件位于被忽略的 `state/` 内，程序不会强制推送。若前一次发布进程异常退出留下锁文件，确认没有发布进程运行后，删除 `state/pages-publish.lock` 再重试。

## 数据和接口说明

`.env`、`config.json`、`state/`、`dist/` 已被 Git 忽略。网页只读取处理后的额度快照，密钥留在本机采集端。发布页面或快照会让能访问该地址的人看到用量与余额，Git 忽略规则不等于网页访问控制。

- Codex 使用 [官方 app-server](https://developers.openai.com/codex/app-server) 的 `account/rateLimits/read`，优先选择 `rateLimitsByLimitId.codex`。
- DeepSeek 使用 [官方余额接口](https://api-docs.deepseek.com/api/get-user-balance/)。
- GLM 按 [Z.ai 官方 Coding 插件](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs) 查询对应站点的 `/api/monitor/usage/quota/limit`。这是官方插件使用的监控接口，仍可能随平台变更；报错时会保留状态，不会填入虚构额度。

可运行 `npm run check` 检查凭据泄露风险及采集、缓存、页面状态测试。GLM / DeepSeek 的真实连通性需在本地填入有效密钥后验证。
