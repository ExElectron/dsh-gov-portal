---
name: publish-dsh-plugin
description: 将 DeepSeek Harness 插件完整上架：阶段一发布到公开 GitHub 仓库（文档清理、.gitignore、git 提交、gh repo create、推送降级、topics），阶段二按 imsai-sh/awesome-deepseek-harness-plugins 官方流程提交到 dsh1024 社区插件目录并创建 PR。适用于插件作者完成「发布仓库 + 目录收录」的完整上架流程，或修复目录提交失败后重新提交。
---

# 发布并提交 DSH 插件（publish-dsh-plugin）

两阶段 Skill：**阶段一**把插件项目发布为公开 GitHub 仓库；**阶段二**把插件提交进
[dsh1024 社区目录](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)（deepseek1024.com 的目录数据源）。

配套脚本（本 Skill 目录下）：

- `scripts/publish-repo.mjs` —— 阶段一自动化（发布仓库）
- `scripts/submit-plugin.mjs` —— 阶段二自动化（目录提交 + PR）

## 适用场景

- 新建插件开发完成，需要上架公开仓库
- 已有公开仓库但尚未收录进 dsh1024 目录
- 目录提交 PR 被静态审查拒绝，需要修正后重新提交
- 需要把内部项目清理后公开（排除备份/示例目录、清除内部站点信息）

## 安全与范围（必须遵守）

- **内部材料不得公开**：发布前确认 `Backup/`、`Example/` 等备份/示例目录被 `.gitignore` 排除；文档（README、docs/）不得包含内部站点名称、示例站点链接、本机绝对路径、邮箱、token 或凭据。
- **目录 PR 单文件约束**：提交到 dsh1024 的 PR 只允许新增/修改/删除 `catalog/plugins/*.json`；禁止改 `README.md`、`catalog/README.md`、工作流或应用代码（两个 README 是 CI 生成的投影）。
- **不执行第三方代码**：目录静态审查只验证元数据，绝不安装依赖、运行生命周期脚本或执行插件代码。
- **授权边界**：仅本地准备（起草、生成 JSON、本地校验）不需要授权；`push`、创建 PR 前必须向用户展示准确的 fork、分支、上游仓库与暂存文件，并获得明确同意。
- **不手动合并**：新增类目录 PR 通过静态审查后由仓库自动 squash merge；修改/删除类 PR 即使通过审查也需维护者人工合并。不得自行合并。

## 阶段一：发布到公开 GitHub 仓库

### 1.1 发布前检查（人工/AI 判断）

1. 确认项目根目录结构；识别需要排除的本地目录（备份、示例、截图、依赖等）。
2. 全文搜索文档与代码注释中的内部站点名称、示例目录引用、本机绝对路径（如 `C:\Users\...`）与内部域名；按需改写为中性描述。
3. 确认没有 `.env`、密钥文件、`~/.dsh` 配置等被纳入。

### 1.2 运行发布脚本

```bash
node <skill-directory>/scripts/publish-repo.mjs \
  --repo <owner>/<repository> \
  --description "公开仓库描述" \
  [--author "Name <email>"] \
  [--message "Initial public release"] \
  [--add-topics dsh-plugin,deepseek-harness]
```

脚本行为：

1. 校验 `gh` 已登录（`gh auth status`）。
2. 若项目尚无 `.gitignore`，写入默认排除规则（`Backup/`、`Example/`、`node_modules/`、`.env`、`shots/*.png` 等）；已存在则保留原文件。
3. `git init`（如未初始化）→ `git add`（尊重 `.gitignore`）→ 校验暂存区不含凭据/私有路径 → 提交（作者信息优先取 `--author`，否则取仓库 `git config`，再退回 `gh api user` 的 login + noreply 邮箱）。
4. 若远程仓库不存在：`gh repo create --public --source=. --remote=origin`（不 push）。
5. `git push -u origin HEAD:main`；若失败（Windows 常见 `schannel: SEC_E_NO_CREDENTIALS`），自动降级为 GitHub Contents API 逐文件上传（`gh api --method PUT .../contents/<path>`，body 经 stdin 传 JSON，避免命令行过长），首个文件上传会自动创建 `main` 分支。
6. 设置 topics（默认 `dsh-plugin`、`deepseek-harness`），供 tokenless 插件发现使用。

### 1.3 发布后核对

- `gh repo view <owner>/<repo> --json visibility,license,defaultBranchRef` 确认为 `PUBLIC`、默认分支存在。
- 远程文件树与本地 `git ls-files` 一致；确认 `Backup/`、`Example/` 等不在远程。
- 仓库已有 `LICENSE`（建议 MIT）且 GitHub 已识别 license。

## 阶段二：提交到 dsh1024 目录

### 2.1 先决条件（脚本自动校验，也可手动核对）

1. 插件仓库公开、未归档、默认分支存在。
2. 仓库含 `dsh-plugin` topic（缺失且当前登录用户拥有该仓库时脚本会自动添加）。
3. `package.json` 声明**非空字符串** `dsh.bundle.patch`；补丁路径相对 manifest 解析，拒绝绝对路径、反斜杠、跳出仓库；补丁文件与 manifest 都在远程默认分支上。
4. 入口文件（`exports["."]` / `main`）已提交到默认分支，或存在自包含 `prepare` 脚本——确保 `github:owner/repo` 安装后能加载（入口未提交只会被标记 UNVERIFIED，不阻塞收录，PR 评论会给出修法）。
5. 作者已实际运行过插件测试并记录证据（目录自动审查不执行第三方代码）。

### 2.2 运行提交脚本

```bash
node <skill-directory>/scripts/submit-plugin.mjs \
  --id <owner>/<repository> \
  --category <ui|theme|session|memory|tools|skill|workflow|notify|model|dev|fun> \
  --description-en "客观的英文简介" \
  --description-zh "客观、具体的中文简介" \
  [--test-evidence "作者实际运行的测试命令与结果"] \
  [--pr-draft]
```

脚本行为：

1. 校验插件远程仓库（公开、topic、manifest、patch、入口），全部通过才继续。
2. 完整克隆 `imsai-sh/awesome-deepseek-harness-plugins` 到临时目录；基于 `origin/main` 创建聚焦分支 `add-<owner>-<repository>`（子目录 ID 会 slug 化路径段）。
3. 调用目录仓库自带的官方脚本 `skills/submit-dsh-plugin/scripts/create-catalog-entry.mjs` 生成唯一目录条目（重复 ID、未知分类、非法 ID 都会报错，禁止绕过手工创建）。
4. 只暂存该 JSON，校验：`git diff --cached --check`、相对 `origin/main` 恰好一个新增文件、文件名与规范化 `id` 一致、中英文简介客观具体、`added` 为当天、内容不含凭据/邮箱/私有路径。
5. 本地跑官方可信静态审查：`node scripts/review-plugin-submission.mjs`（环境变量 `PLUGIN_REVIEW_ROOT` / `PLUGIN_REVIEW_BASE_SHA` / `PLUGIN_REVIEW_HEAD_SHA` / `GITHUB_TOKEN`）。输出必须为 `VERDICT auto-merge`，否则终止（不推送、不建 PR）。
6. 创建/复用用户 fork，推送分支，按 `references/pr-template.md` 模板创建 PR（保持「允许维护者修改」开启）。非草稿新增类 PR 通过平台静态审查后自动合并；草稿 PR 标记 ready 后再审查合并。

### 2.3 提交后跟进

- 返回 PR URL；检查 `Plugin submission review / static-review` 与机器人评论。
- 检查失败时 PR 保持打开，**只通过修改目录 JSON 修复**，不要为了通过检查改动 README 等生成投影。
- 合并后 CI 自动同步目录到 deepseek1024.com 并刷新两个 README，无需任何手工步骤。

## 验证清单

- [ ] `gh auth status` 已登录，`gh` 版本 ≥ 2.x
- [ ] 远程仓库 `PUBLIC`，默认分支存在，`LICENSE` 已识别
- [ ] 远程不含 `Backup/`、`Example/`、`shots/` 等排除目录
- [ ] 仓库 topics 含 `dsh-plugin`（和 `deepseek-harness`）
- [ ] 插件 `package.json` 的 `dsh.bundle.patch` 非空且补丁已提交
- [ ] 入口文件（`exports["."]` / `main`）已提交到默认分支
- [ ] 目录分支相对 `origin/main` 仅一个新增 `catalog/plugins/*.json`
- [ ] 本地静态审查输出 `VERDICT auto-merge`
- [ ] PR 已创建且展示给用户；新增类非草稿 PR 等待自动合并

## 常见问题与已知坑

- **Windows git push 失败 `schannel: SEC_E_NO_CREDENTIALS`**：publish-repo.mjs 自动降级为 Contents API 上传；submit-plugin.mjs 推送前会配置仓库级 `credential.helper "!gh auth git-credential"` 与 `http.sslBackend openssl`。
- **目录仓库没有 git 作者信息**：脚本自动用 `gh api user` 的 login 与 noreply 邮箱配置（仅仓库级，不碰全局配置）。
- **命令行过长导致 `gh` 无法启动**：所有 `gh api` 的 JSON body 一律经 stdin（`--input -`）传入，绝不用 `-f` 传大 base64。
- **PowerShell 控制台中文乱码**：文件内容本身是 UTF-8 正确的；不要依据控制台回显判断内容，用文件读取/JSON 解析确认。
- **工作区不干净**：目录仓库克隆必须干净；插件仓库的其他未提交改动与本 Skill 无关，不要顺手提交。
- **手动合并**：目录 PR 的合并完全由上游工作流决定，不要请求 fork CI 批准，也不要自行 merge。

## 参考

- 上游目录仓库规范：`CONTRIBUTING.md`、`AGENTS.md`、`catalog/categories.json`、`skills/submit-dsh-plugin/SKILL.md`（以线上仓库为准）
- 分类速查：`ui`（界面增强）`theme`（主题外观）`session`（会话消息）`memory`（记忆）`tools`（Agent 工具）`skill`（Skill 工作流）`workflow`（自动化）`notify`（通知集成）`model`（模型提供商）`dev`（开发运行时）`fun`（趣味）
