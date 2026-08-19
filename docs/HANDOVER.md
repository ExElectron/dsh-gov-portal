# dsh-gov-portal 维护说明

## 项目概览

`dsh-gov-portal` 是一个 DeepSeek Harness 插件，在独立端口提供政务服务门户风格的 Web 界面。插件通过宿主进程内的 `apiProxy` 连接真实的会话、模型、权限、审批、统计和工作区能力。

## 目录职责

```text
Dsh_GovUI/
├── lib/index.js              # 插件服务端和 API 桥
├── public/                   # 无构建、零依赖的前端静态资源
├── docs/                     # 公开维护文档
├── test/                     # 冒烟、浏览器和端到端检查
├── package.json              # npm 包与 DSH bundle 声明
└── cordis.patch.yml          # Cordis 插件挂载配置
```

## 架构约定

- `lib/index.js` 在 `dsh web` 宿主进程中运行，负责静态资源、插件端点和 API 转发；修改后需要重启宿主进程。
- `public/` 中的 HTML、CSS 和 JavaScript 不经过构建工具，刷新插件页面即可加载更新。
- 前端状态通过事件流同步，业务请求经插件服务端转发到宿主 `apiProxy`。
- 界面配置保存在浏览器 `localStorage`，插件运行配置保存在 DSH 用户配置目录。

## 验证

```powershell
node test/server-smoke.mjs
node test/e2e-check.mjs
node test/v4-check.mjs
node test/e2e-chat.mjs
```

其中浏览器检查与真实对话检查要求插件服务已启动；真实对话检查会使用模型额度。

## 发布约定

- `Backup/` 和 `Example/` 是本地备份与示例材料，已由 `.gitignore` 排除，禁止加入公开仓库。
- `shots/*.png` 是本地生成的测试截图，默认不纳入版本控制。
- 发布前运行 `git status --ignored`，确认排除目录仅显示为 ignored，且暂存区不含本地配置、凭据或生成物。
