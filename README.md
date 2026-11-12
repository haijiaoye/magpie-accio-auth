# magpie-accio-auth

把 **Accio（阿里 Accio Work）** 作为一条独立供应商接入 [magpie](https://usemagpie.ai) / OpenCode。

## 能做什么

- **浏览器登录**：Accio 官方 PKCE 授权流程，回调落在 `127.0.0.1` 本机端口。
- **真实额度**：读取每日积分 / 每月积分 / 推荐积分，剩 0 的桶折叠到次要位置。
- **商户空间切换**：同一个账号可在「个人空间」和「商户空间（team）」之间切换，
  切换后额度、模型目录、请求都按该空间走。
- **多账号**：magpie 原生多账号，每个账号各自的空间选择互不影响。
- **工具调用**：OpenAI 的 `tools` / `tool_calls` 会转成 Accio 的 Gemini 风格信封，
  工具结果按 `name` 正确配对。

## 安装

```bash
magpie plugin add github:haijiaoye/magpie-accio-auth
```

或在 magpie 的「插件 → 发现」里粘贴仓库地址。

## 使用

1. magpie 左侧 **供应商** → **Accio (阿里)** → 登录。
2. 浏览器里完成 Accio 登录，回到 magpie 即已登录。
3. 需要切到商户空间时：
   - 界面：供应商 → Accio → **添加另一个 Accio (阿里) 账号** →
     **切换 Accio 空间（个人 / 商户）**，选目标空间即可；
   - 命令行：
     ```bash
     magpie plugin login accio 2
     ```
     第二个参数是**登录方式**的序号，不是空间序号：`1` 是浏览器登录，
     `2` 是「切换 Accio 空间」。进入后按提示选择个人空间或某个商户空间。
     也可以直接跑 `magpie plugin login accio`，在菜单里选第 2 项。

切换是**原地更新**同一个账号槽，不会多出一个账号。

## 从 Providers Hub 迁移

如果之前用 `magpie-providers-hub` 的 `hub-accio` 登录过，本插件在**首次加载且
还没有 accio 账号**时会自动把那份登录导入过来，无需重新登录。导入后旧槽不动，
你可以自行移除旧插件。

## 实现要点

Accio 的「商户空间」在接口层就是 **team**：

- 列表：`POST /api/team/queryUserTeams`，token 在 **body**（`{accessToken}`）；
- 上下文：所有网关请求带 `x-team-id` 头；
- 额度类端点还要 `?teamId=`（只带头会 406）。

空间选择作为凭据的一部分存进 magpie 账号槽（`team_id` / `team_name`），
续期时原样保留 —— 否则每次续期都会静默退回个人空间。

对话走 Gemini 风格信封，`token` 必须在 **body**（放 `Authorization` 头会恒流内 402）。

## 隐私

- 插件**不写** magpie 的配置文件。账号只存在 magpie 自己的账号槽里
  （写入走宿主提供的 `client.auth.set`）。
- 切换空间需要读当前账号的 token，因此以**只读**方式读 `plugin-auth.json`
  里**本供应商**的槽（`accio` / `accio#…`），不碰其它供应商的条目。
- 诊断日志默认关闭；`MAGPIE_ACCIO_DEBUG=1` 时写到系统临时目录。

## 测试

```bash
npm test
```

## 许可

MIT
