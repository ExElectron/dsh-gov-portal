#!/usr/bin/env node
/**
 * publish-repo.mjs — 将本地 DSH 插件项目发布为公开 GitHub 仓库（阶段一）。
 *
 * 用法：
 *   node publish-repo.mjs \
 *     --repo owner/repository \
 *     --description "公开仓库描述" \
 *     [--author "Name <email>"] \
 *     [--message "Initial public release"] \
 *     [--add-topics dsh-plugin,deepseek-harness]
 *
 * 行为：
 *   1. 校验 gh 已登录
 *   2. 无 .gitignore 时写入默认排除规则（已有则保留）
 *   3. git init / add / 暂存区安全检查 / commit
 *   4. 远程不存在时 gh repo create --public
 *   5. git push；失败（Windows schannel）则降级为 GitHub Contents API 逐文件上传
 *   6. 设置 topics
 *
 * 安全：
 *   - 尊重已有 .gitignore，绝不覆盖
 *   - 提交前扫描暂存区是否含常见凭据/私有路径
 *   - gh api 的 JSON body 一律经 stdin 传入，避免命令行过长
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_GITIGNORE = `# 本地备份与参考材料
Backup/
Example/

# 生成的测试产物
shots/*.png

# 依赖与本地环境
node_modules/
.env
.env.*
!.env.example

# 编辑器与系统文件
.vscode/
.idea/
*.log
.DS_Store
Thumbs.db
`

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/,
  /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /C:\\Users\\/,
]

function fail(message) {
  console.error(`[publish-repo] ERROR: ${message}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  })
  if (res.error) fail(`${cmd} 无法启动: ${res.error.message}`)
  return res
}

function gh(args, opts = {}) {
  return run('gh', args, opts)
}

function parseArgs(argv) {
  const out = {
    repo: null,
    description: '',
    author: null,
    message: 'Initial public release',
    addTopics: ['dsh-plugin', 'deepseek-harness'],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--repo') out.repo = next()
    else if (a === '--description') out.description = next()
    else if (a === '--author') out.author = next()
    else if (a === '--message') out.message = next()
    else if (a === '--add-topics') out.addTopics = next().split(',').map(s => s.trim()).filter(Boolean)
    else fail(`未知参数: ${a}`)
  }
  if (!out.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(out.repo)) {
    fail('需要 --repo owner/repository')
  }
  return out
}

function detectGitAuthor() {
  const name = run('git', ['config', 'user.name'])
  const email = run('git', ['config', 'user.email'])
  if (name.status === 0 && email.status === 0 && name.stdout.trim() && email.stdout.trim()) {
    return { name: name.stdout.trim(), email: email.stdout.trim() }
  }
  const user = gh(['api', 'user'])
  if (user.status !== 0) fail('无法获取 GitHub 用户信息，请提供 --author "Name <email>"')
  try {
    const me = JSON.parse(user.stdout)
    return { name: me.login, email: me.email || `${me.id}+${me.login}@users.noreply.github.com` }
  } catch {
    fail('无法解析 gh api user 输出，请提供 --author "Name <email>"')
  }
}

function ensureGitignore() {
  if (existsSync('.gitignore')) return
  writeFileSync('.gitignore', DEFAULT_GITIGNORE, 'utf8')
  console.log('[publish-repo] 已创建默认 .gitignore（Backup/ Example/ 等已排除）')
}

function ensureGitRepo() {
  if (existsSync('.git')) return
  const res = run('git', ['init'])
  if (res.status !== 0) fail(`git init 失败: ${res.stderr}`)
  console.log('[publish-repo] 已 git init')
}

function scanStaged() {
  const res = run('git', ['diff', '--cached', '--name-only'])
  if (res.status !== 0) fail(`git diff --cached 失败: ${res.stderr}`)
  const files = res.stdout.split(/\r?\n/).filter(Boolean)
  for (const file of files) {
    if (file.startsWith('.git/')) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        fail(`暂存区 ${file} 疑似包含凭据/私有路径（${pattern}），请处理后重试`)
      }
    }
  }
  return files
}

function repoExists(repo) {
  const res = gh(['repo', 'view', repo, '--json', 'visibility'])
  return res.status === 0
}

function createRepo(repo, description) {
  const args = ['repo', 'create', repo, '--public', '--source=.', '--remote=origin']
  if (description) args.push('--description', description)
  const res = gh(args)
  if (res.status !== 0) fail(`gh repo create 失败: ${res.stderr}`)
  console.log(`[publish-repo] 已创建公开仓库 ${repo}`)
}

function setLocalGitAuth() {
  // 仓库级配置：让 gh 提供凭据并绕开 Windows schannel
  run('git', ['config', 'credential.helper', '!gh auth git-credential'])
  run('git', ['config', 'http.sslBackend', 'openssl'])
}

function pushViaGit(repo) {
  setLocalGitAuth()
  const res = run('git', ['push', '-u', 'origin', 'HEAD:main'])
  if (res.status !== 0) {
    console.warn(`[publish-repo] git push 失败（${res.stderr.trim().split(/\r?\n/)[0] || '未知错误'}），降级为 Contents API 上传`)
    return false
  }
  console.log('[publish-repo] git push 成功')
  return true
}

function pushViaApi(repo, files) {
  const [owner, repository] = repo.split('/')
  // 先传 .gitignore（首个文件会创建默认分支），再传其余
  const ordered = [...files].sort((a, b) => (a === '.gitignore' ? -1 : b === '.gitignore' ? 1 : 0))
  for (const file of ordered) {
    if (file.startsWith('.git/')) continue
    const content = readFileSync(file)
    const body = JSON.stringify({
      message: 'Initial public release',
      content: content.toString('base64'),
    })
    const url = `repos/${owner}/${repository}/contents/${file.split('/').map(encodeURIComponent).join('/')}`
    const res = run('gh', ['api', '--method', 'PUT', url, '--input', '-'], { input: body })
    if (res.status !== 0) fail(`Contents API 上传 ${file} 失败: ${res.stderr}`)
    console.log(`[publish-repo] 已上传 ${file}`)
  }
  console.log('[publish-repo] Contents API 上传完成')
}

function setTopics(repo, topics) {
  if (!topics.length) return
  const args = ['api', '--method', 'PUT', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/topics`]
  for (const t of topics) args.push('-f', `names[]=${t}`)
  const res = gh(args)
  if (res.status !== 0) fail(`设置 topics 失败: ${res.stderr}`)
  console.log(`[publish-repo] topics 已设置: ${topics.join(', ')}`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  // 1. gh 登录
  const auth = gh(['auth', 'status'])
  if (auth.status !== 0) fail('gh 未登录，请先运行 gh auth login')

  // 2. .gitignore + git 仓库
  ensureGitignore()
  ensureGitRepo()

  // 3. 作者信息 + 提交
  const author = args.author ? (() => {
    const m = args.author.match(/^(.+) <([^>]+)>$/)
    if (!m) fail('--author 格式应为 "Name <email>"')
    return { name: m[1], email: m[2] }
  })() : detectGitAuthor()

  run('git', ['config', 'user.name', author.name])
  run('git', ['config', 'user.email', author.email])

  const status = run('git', ['status', '--porcelain'])
  if (status.status !== 0) fail('git status 失败')
  const hasChanges = status.stdout.trim().length > 0
  if (!hasChanges) {
    console.log('[publish-repo] 工作区无改动，跳过提交')
  } else {
    const addRes = run('git', ['add', '-A'])
    if (addRes.status !== 0) fail(`git add 失败: ${addRes.stderr}`)
    const files = scanStaged()
    if (files.length === 0) fail('暂存区为空，没有可发布的内容')
    const commitRes = run('git', ['commit', '-m', args.message])
    if (commitRes.status !== 0) fail(`git commit 失败: ${commitRes.stderr}`)
    console.log(`[publish-repo] 已提交 ${files.length} 个文件`)
  }

  // 4. 创建远程仓库
  if (!repoExists(args.repo)) {
    createRepo(args.repo, args.description)
  } else {
    console.log(`[publish-repo] 仓库 ${args.repo} 已存在，跳过创建`)
  }
  run('git', ['remote', 'get-url', 'origin'])

  // 5. 推送（git 优先，失败降级 Contents API）
  const files = run('git', ['ls-files']).stdout.split(/\r?\n/).filter(Boolean)
  if (!pushViaGit(args.repo)) {
    pushViaApi(args.repo, files)
  }

  // 6. topics
  setTopics(args.repo, args.addTopics)

  console.log(`\n[publish-repo] 完成 → https://github.com/${args.repo}`)
}

main()
