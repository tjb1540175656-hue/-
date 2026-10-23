# 验证记录

- 日期：2026-10-24
- 平台：Windows；Node v22.17.1
- 扩展：Draw Inline 1.0.0
- 核对源码：`C:\Users\15401.DESKTOP-6NAIB41\Downloads\SillyTavern-release`，`package.json` 版本 **1.18.0**
- 已查该参考仓库及相关目录的 `AGENTS.md`：未找到附加文件；前端模块、manifest 与接口以实际源码为准。

## 执行命令

在扩展文件夹中用 PowerShell：

```powershell
$env:ST_SOURCE_ROOT='C:\Users\15401.DESKTOP-6NAIB41\Downloads\SillyTavern-release'
node --test tests/mock.test.mjs
```

结果：

```text
tests 29
pass 29
fail 0
cancelled 0
skipped 0
```

未指定 `ST_SOURCE_ROOT` 时也可直接运行 `node --test tests/mock.test.mjs`；2 项依赖参考源码/其已有 Markdown 库的测试会明确跳过，其他测试不需要安装任何依赖。

## 覆盖项目

- 仅取正文第一处标记；跳过常见思考块、行内/围栏代码。
- 空值、超长、宏、内嵌标记、生图保留触发词校验。
- 后端图片 URL 校验、Markdown 转义、同源路径保持相对地址。
- 提示词包含管道、斜杠、引号也只作为文本传入，不执行斜杠脚本。
- 文字完整后执行；兼顾流式的两种结束事件顺序，重复事件不重复生成。
- 不自动处理历史、开场白、用户、系统、扩展自发消息或思考字段。
- 每条当前版本限一张、全局串行队列、生成锁、重试点击防重。
- 删除前面的 swipe 导致版本编号变化时，也不会给已配图版本再生成第二张。
- 成功正文/extra/当前 swipe 持久化写入；不设置 image/media；保留其他 extra 字段。
- 失败保留标记，状态不带底层异常/提示词，无自动无限重试；手动重试成功。
- 失败元数据经 JSON 序列化/重新加载后仍防自动重试。
- 切换聊天、切走再切回、切换 swipe、切走再切回 swipe、删除、编辑、关闭、停止、相同 chatId 不同角色：均不插入过期图片。
- 新的继续生成在首 token 前就使旧配图任务失效。
- 其他扩展的 display_text 缓存存在时安全拒绝，不删除用户数据。
- 渲染/保存接口抛错时恢复标记；UI 初始化、防重复绑定、开关与缺失接口安全停用。
- **真实源码契约**：提取原生 `/sd` 回调、`generatePicture`、提示词分流和选项处理函数到 Node VM，用假的生图请求验证 quiet 不发消息、返回文件路径、FREE 模式不额外调用 LLM、临时选项恢复。
- **真实 Markdown 引擎**：使用参考酒馆已有的 Showdown 库，确认内联持久 Markdown 在前后文字之间渲染成图片。

## 关键源码依据（参考副本行号）

- `public/scripts/extensions/stable-diffusion/index.js:2990–3095`：`generatePicture` 非导出；quiet 将回调设为空函数，最终返回路径。
- 同文件 `:2860–2881`：保留触发词与 FREE/FREE_EXTENDED 分流。
- 同文件 `:3439–3450`：会话检查、保存图片文件、调用回调、返回路径。
- 同文件 `:4966–5001`：默认发送独立媒体消息的副作用，quiet 可避免。
- 同文件 `:5384–5449`、`:5492–5525`：命令选项临时覆盖/恢复；原生 `sd` 别名。
- 同文件 `:5477–5483`：工具 action 默认会发送图片消息，本扩展不使用/注册该工具。
- `public/scripts/slash-commands/SlashCommandParser.js:43–45, 78–101`：公开命令注册表、来源识别与别名指向同一回调。
- `public/scripts/st-context.js:114–170, 199–200, 237`：实际上下文、事件总线、扩展设置、保存/更新消息接口。
- `public/script.js:3473–3478, 3696–3756, 6583–6750`：结束/接收事件顺序，最终消息和 swipe 数据处理。
- `public/scripts/reasoning.js:1514–1582`：推理区与正文拆分/事件处理。
- `public/script.js:1974–1985, 6837–6882, 9352–9378`：原生消息更新、swipe 同步方式及 saveChatConditional 吞错限制。
- `public/scripts/extensions.js:824–826` 及内置扩展 manifest：浏览器 ES module 入口规范。

## 没有执行、不能证明的项目

没有调用任何网络生图 API 或 ComfyUI `/prompt`，没有使用 GPU，没有实际出图、启动/重启任何服务，没有改动参考酒馆源文件/配置，没有安装进电脑酒馆。

手机的具体酒馆版本/浏览器、工作流是否正确替换提示词、ComfyUI 连通性、图片质量和真实聊天服务器保存结果尚未实机验证。原生保存接口可能吞掉服务器错误，不能把 mock 通过当作已证明真实落盘。请按 README 在手机端安装后确认。
