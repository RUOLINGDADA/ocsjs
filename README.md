# OCS 网课助手（AI 题库分支）

[![最新版本](https://img.shields.io/github/v/release/RUOLINGDADA/ocsjs?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/RUOLINGDADA/ocsjs/releases/latest)
[![许可证](https://img.shields.io/github/license/RUOLINGDADA/ocsjs?label=%E8%AE%B8%E5%8F%AF%E8%AF%81)](./LICENSE)

基于 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)（OCS 网课助手）的分支。在原有固定题库之外，可以填入自己的大模型接口让 AI 答题；答题失败会自动重试，全部答完、补答结束后才按完成率决定是否提交。

支持的平台与原版相同：超星学习通、知到智慧树、职教云、智慧职教、中国大学 MOOC、雨课堂。

## 和官方版的区别

| | 官方版 5.2.3 | 本分支 6.x |
| --- | --- | --- |
| 答题来源 | 第三方固定题库 | 固定题库 + 自己配置的大模型（OpenAI 兼容、OpenAI Responses、Anthropic、Gemini） |
| 答题失败 | 记为失败，不再处理 | 退避重试；全部跑完后再补答一轮 |
| 提交时机 | 搜题超时的题直接算失败，完成率够就提交 | 重试和补答都结束后再算完成率 |
| 超星跳转后的第一题 | 经常在加密文字解密前读题，读到乱码 | 等解密完成、新题目显示出来再读题 |
| 界面 | 等宽字体、emoji 图标 | 系统中文字体、线条图标、答题卡式进度 |
| 更新来源 | 官方 | 本仓库的 Release |

## 安装

1. 浏览器里装一个脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [ScriptCat 脚本猫](https://docs.scriptcat.org/)。
2. 点开下面的链接，脚本管理器会弹出安装页：
   - [标准版 ocs.user.js](https://github.com/RUOLINGDADA/ocsjs/releases/latest/download/ocs.user.js)：大多数人用这个。
   - [通用版 ocs.common.user.js](https://github.com/RUOLINGDADA/ocsjs/releases/latest/download/ocs.common.user.js)：AI 接口地址不在内置白名单里（自建网关、中转站）时用这个。
3. 如果装过以前的「OCS 网课助手 AI 版」（版本号形如 5.2.3-ai.2），在脚本管理器里把它删掉。它的标识和本分支不同，不会被自动替换。
4. 打开网课页面，悬浮窗标题栏显示 `OCS 6.x.x` 就是装好了。

本分支和官方版使用相同的脚本名称与命名空间，版本号更高。已经装了官方版的，安装时会显示为「更新」并直接替换。之后脚本管理器只会从本仓库的 Release 检查更新。

脚本管理器不允许一个脚本停用另一个脚本。如果页面上同时运行着两个 OCS（比如旧的 AI 版没删，或者另一个脚本管理器里还装着官方版），本脚本会停止答题、不保存也不提交，并提示你去停用另一个。两个脚本同时答题会互相取消对方选中的选项，还会重复提交。

## 配置 AI 题库

1. 悬浮窗工具栏点「AI 题库」图标（芯片形状），或进入「通用 → 全局设置 → AI 题库」。
2. 点「添加配置」，选一个供应商预设（如 DeepSeek），填入 API Key 后保存。
3. 点「测试连接」，确认能连通。
4. 打开「启用 AI 答题」。
5. 进入章节测试、作业或考试页面，脚本会自动开始答题。

API Key 以明文保存在脚本管理器的本地存储里，题目内容会发送到你配置的服务。支持哪些服务、各字段的含义、域名白名单等，见 [docs/AI_ANSWERER.md](./docs/AI_ANSWERER.md)。

## 重试与提交

- 一道题报错、超时、没有答案、答案和选项对不上，都会等待一会儿后重试，默认最多 3 次。
- 全部题目跑完后，对还没答上的题再补答 1 轮。
- AI 回复为空，或者思考过程把回复长度用完（DeepSeek V4 等思考模型常见），会自动调大上限重试；DeepSeek 系模型第二次仍被截断时会关闭思考。
- 补答结束后才计算完成率，达到「答案提交方式（提交率）」设置的比例才自动提交，否则只保存。

尝试次数和补答轮数在「通用 → 全局设置 → 高级设置」里调整。答题结果页的答题卡颜色：灰框是未开始，底部有绿线在动是正在搜题，黄色是等待重试，红色是重试后仍没答上，绿色实心是已作答。

## 常见问题

**提示「页面上还有另一个 OCS 在运行」**
脚本管理器里还启用着别的 OCS。停用它，然后刷新页面。

**提示「模型返回了空内容」或「用完了最大回复 token」**
通常重试后会自动恢复。经常出现的话，在 AI 题库配置里调大「最大回复 token」（默认 4096）。

**接口请求被拦截，或提示域名不在白名单**
改装通用版，或在脚本管理器里给脚本添加对应的 `@connect`。

**某道题一直是红色**
点开答题卡上的那一格，可以看到失败原因和尝试次数。手动作答后再保存或提交。

更多问题见 [docs/AI_ANSWERER.md](./docs/AI_ANSWERER.md) 第 8 节；各平台的基础用法见原版文档 [docs.ocsjs.com](https://docs.ocsjs.com)。

## 开发

需要 Node.js 20 以上和 pnpm 9。

```bash
pnpm install
npm test          # 答案匹配、AI 题库、答题引擎的单元测试
npm run build     # 构建，产物在 dist/
npm run dev       # 开发模式，监听源码与样式自动编译
```

本地调试时把 `dist/ocs.dev.user.js` 装进脚本管理器，它会从本地 `dist/` 加载代码。

```
packages/core/src/core/worker/   答题引擎：逐题流水线、重试、补答、提交判断、页面就绪等待
packages/core/src/core/ai/       AI 题库：各协议的请求与响应解析、重试、答案解析
packages/scripts/src/projects/   各平台脚本（超星、智慧树、职教云、智慧职教、中国大学 MOOC、雨课堂）
packages/scripts/src/utils/      界面组件、AI 配置面板、多实例检测
packages/scripts/assets/less/    样式：tokens.less 设计变量，base.less 基础组件，custom.less 功能模块，theme.less 视觉层
tests/                           单元测试
docs/                            文档
```

发布新版本：推送 `vX.Y.Z` 格式的标签（版本号要高于上一个版本），GitHub Actions 会跑测试、构建，并把脚本挂到对应的 Release 上。已安装的用户会从最新 Release 收到更新。

```bash
git tag v6.0.1
git push origin v6.0.1
```

提交代码前请看 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 致谢与许可

本项目基于 [enncy](https://github.com/enncy) 的 [OCS 网课助手](https://github.com/ocsjs/ocsjs)，以 [MIT 许可证](./LICENSE) 发布。原项目的更新记录保留在 [CHANGELOG.md](./CHANGELOG.md)。

本项目仅供学习和研究使用。使用前请确认符合所在学校和平台的规定，由此产生的后果由使用者自行承担。AI 给出的答案可能有错，提交前请自行检查。
