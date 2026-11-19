# magpie-accio-auth

把 **Accio（阿里 Accio Work）** 接入 [magpie](https://usemagpie.ai) / OpenCode。

一个插件装完出现**两条独立供应商**：

| 供应商 | 站点 | 模型 |
| --- | --- | --- |
| `accio` · Accio (阿里) | `www.accio-ai.com`（国内版） | GLM、DeepSeek、Kimi、Qwen 等 15 个 |
| `accio-global` · Accio 国际版 | `www.accio.com`（国际版） | Claude、GPT、Gemini、Grok 等 27 个 |

两条供应商各自开关、各自额度，互不影响。**同一个 Accio 账号只登录一次即可**：
国内版登录后，国际版会自动复用那份登录态（同一网关、同一套 token）。

## 能做什么

- **浏览器登录**：Accio 官方 PKCE 授权流程，回调落在 `127.0.0.1` 本机端口。
- **国内版 / 国际版**：两条供应商共用同一套账号，但模型目录不同 ——
  国际版才有 Claude / GPT / Gemini，国内版才有 GLM / DeepSeek / Kimi。
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

## 更新

本插件从 GitHub 安装，magpie 会比对 `main` 分支的最新提交（最多每 10 分钟查一次），
有新版本时「插件」页出现小红点、「已安装」显示「1 update」，点 **更新** 即可，或：

```bash
magpie plugin update
```

注意：

- 安装地址**不要带 `#提交号`**（如 `#e5702f6`），固定提交的安装不会收到更新提示；
  已这样装过的，重新执行上面的安装命令即可。
- 带标签安装（如 `#v0.2.3`）只会在该标签变化时提示，不跟随 `main`。
- 从固定提交换回无 `#` 地址后，如发现 Accio 供应商被关闭、模型勾选被重置，
  执行 `magpie provider on accio`（国际版为 `accio-global`）并重新勾选模型。
- 各版本改动见 [Releases](https://github.com/haijiaoye/magpie-accio-auth/releases)。

## 使用

1. magpie 左侧 **供应商** → 选 **Accio (阿里)**（国内）或 **Accio 国际版** → 登录。
   先登录其中一条即可，另一条会自动复用（也可以各自单独登录成不同账号）。
2. 浏览器里完成 Accio 登录，回到 magpie 即已登录。
3. 需要切到商户空间时：
   - 界面：供应商 → 对应 Accio → **添加另一个账号** →
     **切换 Accio 空间（个人 / 商户）**，选目标空间即可；
   - 命令行：
     ```bash
     magpie plugin login accio 2
     magpie plugin login accio-global 2
     ```
     第二个参数是**登录方式**的序号，不是空间序号：`1` 是浏览器登录，
     `2` 是「切换 Accio 空间」。进入后按提示选择个人空间或某个商户空间
     （切换作用于**哪条供应商**由命令里的 provider 决定）。
     也可以直接跑 `magpie plugin login accio`，在菜单里选第 2 项。

切换是**原地更新**同一个账号槽，不会多出一个账号。

## 从 Providers Hub 迁移

如果之前用 `magpie-providers-hub` 的 `hub-accio` 登录过，本插件在**首次加载且
还没有 accio 账号**时会自动把那份登录导入过来，无需重新登录。导入后旧槽不动，
你可以自行移除旧插件。

## 实现要点

国内版与国际版**共用同一个网关**（`phoenix-gw.alibaba.com`）和同一套账号，
只有两处不同：登录站点，以及每个请求的 `x-package-region` 头（国际版为
`GLOBAL`）。区域会随凭据一起保存，续期与空间切换都原样保留。

⚠️ 区域不是显示偏好：同一个 token 带上 `GLOBAL` 后拿到的是**另一套目录**，
且同名模型（Qwen 3.8 Max）在两边的 `modelCode` 也不同 —— 所以模型映射表
按区域分开存，兜底目录也是两张表，不能合并。

⚠️ 请求体的 `properties` 只放 `normalized_response`。多放 `utdid` / `version` /
`appKey` 在国内模型上没事，但国际版的 GPT / Claude 会直接拒收
（`Unknown parameter: 'utdid'`，HTTP 200 + 流内 500）。`utdid` 只放在请求头。

`utdid` 是阿里网关的**装机级风控基线**（缺了会吃到 200 + 风控拦截页），本插件
把它落盘复用：首次生成后写 `~/.cache/magpie-accio/utdid`（`0600`），之后 magpie
重启也是同一个指纹。落盘用 hard link 原子发布，所以同时开多个 magpie 进程也会
收敛到同一个 id，而不是各写各的。

Accio 的「商户空间」在接口层就是 **team**：

- 列表：`POST /api/team/queryUserTeams`，token 在 **body**（`{accessToken}`）；
- 上下文：所有网关请求带 `x-team-id` 头；
- 额度类端点还要 `?teamId=`（只带头会 406）。

空间选择作为凭据的一部分存进 magpie 账号槽（`team_id` / `team_name`），
续期时原样保留 —— 否则每次续期都会静默退回个人空间。

对话走 Gemini 风格信封，`token` 必须在 **body**（放 `Authorization` 头会恒流内 402）。

### refresh_token 轮换

Accio 的 `refresh_token` 用一次就会换新。国内版和国际版复用同一个登录态，
所以两个供应商槽一开始持有同一个 `refresh_token`。插件做了三层保护：

- **进程内去重**：同一个 `refresh_token` 只发一次续期，并发请求共享结果。
- **跨进程锁**：按 `refresh_token` 的 SHA-256 指纹加锁；锁内发现它刚被其它 magpie
  进程换过时，直接复用新凭据，不再消费旧 token。
- **跨槽同步**：任一供应商续期后，把新凭据同步给仍持有同一旧 token 的另一个
  Accio 供应商；如果自己的旧 token 已被换掉，会接管兄弟槽里同账号的新凭据。

续期接口返回 HTML 拦截页时按风控处理。续期响应缺 `accessToken` 或
`refreshToken` 时，会保留旧值，不把仍可用的凭据丢掉。

### 风控拦截页

网关返回 `401/403 + text/html` 时，插件直接返回 `PERMISSION_DENIED`，
不续期、不重试。这类页面通常表示账号受限或请求被 WAF 拦截；继续续期会白白
消费一次性 `refresh_token`，继续重试也只会再次撞上拦截。

## 隐私

- 插件**不写** magpie 的配置文件。账号只存在 magpie 自己的账号槽里
  （写入走宿主提供的 `client.auth.set`）。
- 切换空间和续期同步需要读当前 token，因此以**只读**方式读取 `plugin-auth.json`
  里的 `accio` / `accio#…` 与 `accio-global` / `accio-global#…` 槽，不碰其它供应商。
  续期同步只通过 `client.auth.set` 更新仍持有同一旧 `refresh_token` 的 Accio 主槽。
- 诊断日志默认关闭；`MAGPIE_ACCIO_DEBUG=1` 时写到系统临时目录。
- 续期时会在 `~/.cache/magpie-accio/renew/` 放锁和短期轮换记录（`0600`），
  用来让多个 magpie 进程复用同一次续期结果；记录按旧 token 的哈希命名，
  5 分钟后自动删除。
- 设备指纹存在 `~/.cache/magpie-accio/utdid`（随机 id，不含账号信息）。
  想换位置或固定值：

  | 环境变量 | 作用 |
  | --- | --- |
  | `MAGPIE_ACCIO_STATE_DIR` | 状态目录整体搬家（默认 `$XDG_CACHE_HOME` 或 `~/.cache` 下的 `magpie-accio`） |
  | `MAGPIE_ACCIO_UTDID` | 直接指定指纹，不再读写状态文件 |

## 测试

```bash
npm test
```

## 许可

MIT
