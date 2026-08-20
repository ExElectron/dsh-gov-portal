#!/usr/bin/env node
/**
 * submit-plugin.mjs — 将 DSH 插件提交到 imsai-sh/awesome-deepseek-harness-plugins 目录并创建 PR（阶段二）。
 *
 * 用法：
 *   node submit-plugin.mjs \
 *     --id owner/repository \
 *     --category ui \
 *     --description-en "英文简介" \
 *     --description-zh "中文简介" \
 *     [--test-evidence "作者测试命令与结果"] \
 *     [--pr-draft] \
 *     [--catalog-root <已有目录 checkout>] \
 *     [--keep]
 *
 * 流程：
 *   1. 校验插件远程仓库（公开 / topic / manifest / patch / 入口）
 *   2. 克隆（或复用）目录仓库，基于 origin/main 创建聚焦分支
 *   3. 调用官方 create-catalog-entry.mjs 生成唯一目录条目
 *   4. 校验单文件约束并提交
 *   5. 本地跑官方静态审查（必须 VERDICT auto-merge）
 *   6. fork → push → 创建 PR
 *
 * 安全：
 *   - 只允许目录 PR 变更 catalog/plugins/*.json
 *   - 不安装依赖、不执行第三方插件代码
 *   - push / PR 属于外部副作用，调用前应已获得用户授权
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CATALOG_UPSTREAM = 'imsai-sh/awesome-deepseek-harness-plugins'
const CATALOG_URL = `https://github.com/${CATALOG_UPSTREAM}.git`

function fail(message) {
  console.error(`[submit-plugin] ERROR: ${message}`)
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

function ghJson(args) {
  const res = gh(args)
  if (res.status !== 0) return null
  try { return JSON.parse(res.stdout) } catch { return null }
}

function parseArgs(argv) {
  const out = {
    id: null,
    category: null,
    descriptionEn: '',
    descriptionZh: '',
    testEvidence: '',
    prDraft: false,
    catalogRoot: null,
    keep: false,
    author: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--id') out.id = next()
    else if (a === '--category') out.category = next()
    else if (a === '--description-en') out.descriptionEn = next()
    else if (a === '--description-zh') out.descriptionZh = next()
    else if (a === '--test-evidence') out.testEvidence = next()
    else if (a === '--pr-draft') out.prDraft = true
    else if (a === '--catalog-root') out.catalogRoot = path.resolve(next())
    else if (a === '--keep') out.keep = true
    else if (a === '--author') out.author = next()
    else fail(`未知参数: ${a}`)
  }
  if (!out.id || !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(out.id)) fail('需要 --id owner/repository（子包: owner/repository/sub/dir）')
  if (!out.category) fail('需要 --category')
  if (!out.descriptionEn || !out.descriptionZh) fail('需要 --description-en 与 --description-zh')
  const parts = out.id.split('/')
  if (parts.length < 2 || parts.some(p => p === '.' || p === '..')) fail('非法 ID（路径段不得为 . 或 ..）')
  if (out.id.length > 201) fail('ID 过长（>201 字符）')
  return out
}

function slugifyId(id) {
  return id.split('/')
    .map(seg => seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .join('--')
}

function detectAuthor(preferred) {
  if (preferred) {
    const m = preferred.match(/^(.+) <([^>]+)>$/)
    if (!m) fail('--author 格式应为 "Name <email>"')
    return { name: m[1], email: m[2] }
  }
  const user = ghJson(['api', 'user'])
  if (!user) fail('无法获取 GitHub 用户信息，请提供 --author "Name <email>"')
  return { name: user.login, email: user.email || `${user.id}+${user.login}@users.noreply.github.com` }
}

// ---------- 1. 插件远程仓库校验 ----------

async function verifyPluginRepo(id) {
  const [owner, repository] = id.split('/')
  const repoInfo = ghJson(['repo', 'view', `${owner}/${repository}`, '--json', 'visibility,defaultBranchRef,isArchived'])
  if (!repoInfo) fail(`插件仓库 ${owner}/${repository} 不存在或无法访问`)
  if (repoInfo.visibility !== 'PUBLIC') fail(`插件仓库 ${owner}/${repository} 不是公开仓库`)
  if (repoInfo.isArchived) fail(`插件仓库 ${owner}/${repository} 已归档`)
  const branch = repoInfo.defaultBranchRef?.name
  if (!branch) fail(`插件仓库 ${owner}/${repository} 没有默认分支`)

  // topics：缺 dsh-plugin 且当前用户拥有该仓库时自动添加
  const topics = ghJson(['api', `repos/${owner}/${repository}/topics`])?.names ?? []
  const me = ghJson(['api', 'user'])?.login
  if (!topics.includes('dsh-plugin') && me === owner) {
    const res = gh(['api', '--method', 'PUT', '-H', 'Accept: application/vnd.github+json', `repos/${owner}/${repository}/topics`, '-f', 'names[]=dsh-plugin'])
    if (res.status !== 0) console.warn(`[submit-plugin] 自动添加 dsh-plugin topic 失败: ${res.stderr.trim()}`)
    else console.log('[submit-plugin] 已添加 dsh-plugin topic')
  } else if (!topics.includes('dsh-plugin')) {
    console.warn('[submit-plugin] 仓库缺少 dsh-plugin topic（且当前用户非仓库所有者，无法自动添加）')
  }

  // 全树文件集合（用于补丁/入口存在性校验）
  const tree = ghJson(['api', `repos/${owner}/${repository}/git/trees/${branch}?recursive=1`])
  if (!tree) fail(`无法读取 ${owner}/${repository} 的默认分支树`)
  const files = new Set((tree.tree ?? []).filter(n => n.type === 'blob').map(n => n.path))

  const getContent = async (filePath) => {
    const res = gh(['api', `repos/${owner}/${repository}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`])
    if (res.status !== 0) return null
    try {
      const blob = JSON.parse(res.stdout)
      return Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8')
    } catch { return null }
  }

  // manifest 定位：两段 ID 用根 package.json（若缺 dsh.bundle.patch 则找其他嵌套 manifest）；子目录 ID 必须在指定路径
  const subPath = id.split('/').slice(2).join('/')
  let manifestPath = subPath ? `${subPath}/package.json` : 'package.json'
  let manifestText = await getContent(manifestPath)
  if (!subPath && manifestText) {
    const parsed = JSON.parse(manifestText)
    if (!parsed?.dsh?.bundle?.patch || !String(parsed.dsh.bundle.patch).trim()) {
      // 根 manifest 无 patch：在树里找第一个声明 patch 的 package.json（排除 node_modules）
      const candidates = [...files].filter(f => f.endsWith('/package.json') || f === 'package.json').sort((a, b) => a.split('/').length - b.split('/').length)
      for (const candidate of candidates) {
        const text = await getContent(candidate)
        if (!text) continue
        try {
          const p = JSON.parse(text)
          if (p?.dsh?.bundle?.patch && String(p.dsh.bundle.patch).trim()) {
            manifestPath = candidate
            manifestText = text
            break
          }
        } catch { /* skip */ }
      }
    }
  }
  if (!manifestText) fail(`未找到 manifest：${manifestPath}（请确认文件已在默认分支 ${branch} 提交）`)

  let manifest
  try { manifest = JSON.parse(manifestText) } catch { fail(`manifest ${manifestPath} 不是合法 JSON`) }
  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !patch.trim()) fail(`manifest ${manifestPath} 未声明非空 dsh.bundle.patch`)

  const manifestDir = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : ''
  const resolveRel = (rel) => {
    if (path.posix.isAbsolute(rel) || rel.includes('\\')) return null
    const resolved = path.posix.normalize(path.posix.join(manifestDir, rel))
    if (resolved === '..' || resolved.startsWith('../')) return null
    return resolved
  }
  const patchPath = resolveRel(patch)
  if (!patchPath) fail(`manifest ${manifestPath} 的 dsh.bundle.patch 路径非法（拒绝绝对路径/反斜杠/跳出仓库）`)
  if (!files.has(patchPath)) fail(`补丁文件 ${patchPath} 不在默认分支 ${branch} 上（需先提交并推送）`)

  // 入口文件（exports["."] / main）—— 未提交只警告（UNVERIFIED），不阻塞
  let entry = manifest?.exports
  if (typeof entry === 'object' && entry !== null) {
    const root = entry['.']
    if (typeof root === 'string') entry = root
    else if (root && typeof root === 'object') {
      entry = ['default', 'import', 'node', 'require'].map(k => root[k]).find(v => typeof v === 'string')
    } else entry = undefined
  }
  if (typeof entry !== 'string') entry = manifest?.main
  let entryCommitted = true
  if (typeof entry === 'string') {
    const entryPath = resolveRel(entry)
    entryCommitted = !!entryPath && files.has(entryPath)
  }
  const prepare = manifest?.scripts?.prepare
  const buildAllowance = typeof prepare === 'string' && prepare.trim().length > 0

  console.log(`[submit-plugin] 插件校验通过: ${id}`)
  console.log(`  manifest: ${manifestPath} → patch: ${patchPath}`)
  console.log(`  入口${entryCommitted ? '已提交' : '未提交（将标记 UNVERIFIED）'}${buildAllowance ? '，含 prepare 构建' : ''}`)
  return { owner, repository, entryCommitted }
}

// ---------- 2-4. 目录 checkout / 分支 / 条目 ----------

function prepareCatalog(args) {
  let catalogRoot = args.catalogRoot
  let cleanup = null
  if (!catalogRoot) {
    catalogRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-'))
    cleanup = () => { if (!args.keep) rmSync(catalogRoot, { recursive: true, force: true }) }
    const clone = run('gh', ['repo', 'clone', CATALOG_UPSTREAM, catalogRoot])
    if (clone.status !== 0) fail(`克隆目录仓库失败: ${clone.stderr}`)
  } else {
    const dirty = run('git', ['status', '--porcelain'], { cwd: catalogRoot })
    if (dirty.status !== 0 || dirty.stdout.trim()) fail(`目录 checkout ${catalogRoot} 工作区不干净，请先清理`)
    const fetch = run('git', ['fetch', 'origin', 'main'], { cwd: catalogRoot })
    if (fetch.status !== 0) fail(`git fetch origin main 失败: ${fetch.stderr}`)
  }
  console.log(`[submit-plugin] 目录 checkout: ${catalogRoot}`)
  return { catalogRoot, cleanup }
}

function createEntry(args, catalogRoot) {
  const branchName = `add-${slugifyId(args.id)}`
  const checkout = run('git', ['checkout', '-B', branchName, 'origin/main'], { cwd: catalogRoot })
  if (checkout.status !== 0) fail(`创建分支失败: ${checkout.stderr}`)

  const script = path.join(catalogRoot, 'skills', 'submit-dsh-plugin', 'scripts', 'create-catalog-entry.mjs')
  if (!existsSync(script)) fail(`目录仓库缺少官方脚本 ${script}（请确认目录仓库为最新）`)
  const res = run('node', [
    script,
    '--catalog-root', catalogRoot,
    '--id', args.id,
    '--category', args.category,
    '--description-en', args.descriptionEn,
    '--description-zh', args.descriptionZh,
  ], { cwd: catalogRoot })
  if (res.status !== 0) fail(`create-catalog-entry 失败: ${res.stderr}`)

  // 校验：恰好一个新增 catalog/plugins/*.json
  const added = run('git', ['add', 'catalog/plugins'], { cwd: catalogRoot })
  if (added.status !== 0) fail(`git add 失败: ${added.stderr}`)
  const check = run('git', ['diff', '--cached', '--check'], { cwd: catalogRoot })
  if (check.status !== 0) fail(`git diff --cached --check 失败:\n${check.stdout}${check.stderr}`)
  const names = run('git', ['diff', '--cached', '--name-only'], { cwd: catalogRoot }).stdout.split(/\r?\n/).filter(Boolean)
  if (names.length !== 1 || !/^catalog\/plugins\/[^/]+\.json$/.test(names[0])) {
    fail(`目录 PR 必须只变更一个 catalog/plugins/*.json，实际: ${names.join(', ') || '(空)'}`)
  }
  const entryFile = names[0]

  // 条目内容安全检查（凭据/邮箱/私有路径）
  const entryText = readFileSync(path.join(catalogRoot, entryFile), 'utf8')
  const entry = JSON.parse(entryText)
  if (entry.id !== args.id) fail(`条目 id 与 --id 不一致: ${entry.id}`)
  if (/gh[pousr]_[A-Za-z0-9]{20,}|C:\\Users\\|@[a-z0-9.-]+\.(com|cn|net|org)\b/i.test(entryText.replace(entry.id, ''))) {
    fail(`条目内容疑似包含凭据/私有路径/邮箱: ${entryFile}`)
  }

  const author = detectAuthor(args.author)
  run('git', ['config', 'user.name', author.name], { cwd: catalogRoot })
  run('git', ['config', 'user.email', author.email], { cwd: catalogRoot })
  const commit = run('git', ['commit', '-m', `catalog: add ${args.id}`], { cwd: catalogRoot })
  if (commit.status !== 0) fail(`git commit 失败: ${commit.stderr}`)

  const baseSha = run('git', ['rev-parse', 'origin/main'], { cwd: catalogRoot }).stdout.trim()
  const headSha = run('git', ['rev-parse', 'HEAD'], { cwd: catalogRoot }).stdout.trim()
  return { branchName, entryFile, baseSha, headSha }
}

// ---------- 5. 本地静态审查 ----------

function runReview(args, catalogRoot, baseSha, headSha) {
  const script = path.join(catalogRoot, 'scripts', 'review-plugin-submission.mjs')
  if (!existsSync(script)) fail(`目录仓库缺少审查脚本 ${script}`)
  const env = {
    ...process.env,
    PLUGIN_REVIEW_ROOT: catalogRoot,
    PLUGIN_REVIEW_BASE_SHA: baseSha,
    PLUGIN_REVIEW_HEAD_SHA: headSha,
    GITHUB_TOKEN: run('gh', ['auth', 'token']).stdout.trim(),
  }
  const res = run('node', [script], { cwd: catalogRoot, env })
  console.log(res.stdout)
  if (res.stderr) console.error(res.stderr)
  if (res.status !== 0 || !/VERDICT auto-merge/.test(res.stdout)) {
    fail('本地静态审查未通过（需要 VERDICT auto-merge），已终止，未推送未建 PR')
  }
  console.log('[submit-plugin] 本地静态审查通过（VERDICT auto-merge）')
}

// ---------- 6. fork / push / PR ----------

function forkAndPush(args, catalogRoot, branchName) {
  const me = ghJson(['api', 'user'])?.login
  if (!me) fail('无法获取当前 GitHub 用户')
  const forkUrl = `https://github.com/${me}/${CATALOG_UPSTREAM.split('/')[1]}.git`
  const forkView = ghJson(['repo', 'view', `${me}/${CATALOG_UPSTREAM.split('/')[1]}`, '--json', 'isFork'])
  if (!forkView) {
    const fork = gh(['repo', 'fork', CATALOG_UPSTREAM, '--clone=false'])
    if (fork.status !== 0) fail(`创建 fork 失败: ${fork.stderr}`)
    console.log('[submit-plugin] 已创建 fork')
  } else {
    console.log('[submit-plugin] 复用已有 fork')
  }

  const remotes = run('git', ['remote'], { cwd: catalogRoot }).stdout.split(/\r?\n/).filter(Boolean)
  if (!remotes.includes('fork')) {
    run('git', ['remote', 'add', 'fork', forkUrl], { cwd: catalogRoot })
  }
  // Windows 推送加固：gh 凭据 + 绕开 schannel
  run('git', ['config', 'credential.helper', '!gh auth git-credential'], { cwd: catalogRoot })
  run('git', ['config', 'http.sslBackend', 'openssl'], { cwd: catalogRoot })
  const push = run('git', ['push', '-u', 'fork', branchName], { cwd: catalogRoot })
  if (push.status !== 0) fail(`推送分支失败: ${push.stderr}`)
  console.log(`[submit-plugin] 已推送 ${me}:${branchName}`)
  return me
}

function prBody(args, entryFile) {
  const templatePath = path.join(__dirname, '..', 'references', 'pr-template.md')
  let body = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '## Summary\n\nAdd `{{ID}}` to the DeepSeek Harness plugin catalog.'
  const evidence = args.testEvidence.trim() || '（作者未提供测试证据，请以插件仓库 README 与测试脚本为准）'
  body = body
    .replaceAll('{{ID}}', args.id)
    .replaceAll('{{CATEGORY}}', args.category)
    .replaceAll('{{FILE_NAME}}', entryFile)
    .replaceAll('{{REPOSITORY_URL}}', `https://github.com/${args.id.split('/').slice(0, 2).join('/')}`)
    .replaceAll('{{TEST_EVIDENCE}}', evidence)
  return body
}

function createPr(args, me, branchName, body) {
  const prArgs = [
    'pr', 'create',
    '--repo', CATALOG_UPSTREAM,
    '--base', 'main',
    '--head', `${me}:${branchName}`,
    '--title', `catalog: add ${args.id}`,
    '--body', body,
  ]
  if (args.prDraft) prArgs.push('--draft')
  const res = gh(prArgs)
  if (res.status !== 0) fail(`创建 PR 失败: ${res.stderr}`)
  return res.stdout.trim()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const auth = gh(['auth', 'status'])
  if (auth.status !== 0) fail('gh 未登录，请先运行 gh auth login')

  const { entryCommitted } = await verifyPluginRepo(args.id)
  if (!entryCommitted) {
    console.warn('[submit-plugin] 提示：插件入口文件未提交到默认分支，目录会将其标记为 UNVERIFIED（收录不受影响，PR 评论会给出修法）')
  }

  const { catalogRoot, cleanup } = prepareCatalog(args)
  try {
    const { branchName, entryFile, baseSha, headSha } = createEntry(args, catalogRoot)
    runReview(args, catalogRoot, baseSha, headSha)
    const me = forkAndPush(args, catalogRoot, branchName)
    const url = createPr(args, me, branchName, prBody(args, entryFile))
    console.log(`\n[submit-plugin] 完成 → ${url}`)
  } finally {
    cleanup?.()
  }
}

main()
