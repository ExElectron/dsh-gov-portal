# dsh 运行时集成面全解：Cordis 插件在 3081 独立端口拉起 HTTP+WebSocket，并把浏览器消息 1:1 派发进 dsh Agent

> 目标：在 DeepSeek Harness (dsh) 运行时内开发一个 Cordis 插件，插件在独立端口 **3081** 起自己的 HTTP + WebSocket 服务，浏览器页面的消息真实进入 dsh 的 Agent Loop，**1:1 复用 dsh 的会话、模型、权限、模式、统计能力，绝不硬编码**。
>
> 本文档仅讲集成面（不写业务实现）。所有代码摘录均来自本机已安装的 dsh **0.1.0-rc.6** 与参考插件 `@linxin666/dsh-remote-web-ui@0.1.14`，路径与行号可复核。
>
> 相关键路径：
> - dsh CLI：`C:\Users\17151\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（`lib/bin.js`、`lib/profile-boot-DG5t9aNs.js`、`lib/plugin-9h8shc4d.js`、`config/agent-presets/`）
> - 依赖包：`...\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 下 `dsh-host-webserver`、`dsh-host-apiproxy`、`dsh-client-connection`、`dsh-api-gateway`、`dsh-typert-protocol`、`dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-session-stats`、`dsh-session-projection`、`dsh-token-meter`、`dsh-settings`(+`dsh-settings-file`)、`dsh-permission-presets`、`dsh-sandbox-policy`、`dsh-headless`、`dsh-web-app`、`dsh-api-remotes`、`dsh-base` 等
> - 参考插件：`C:\Users\17151\.dsh\profiles\web\node_modules\@linxin666\dsh-remote-web-ui\`（`lib/index.js` 2151 行 = 宿主侧；`lib/mobile.js` = 移动端页面+客户端；`cordis.patch.yml` = bundle patch）
> - 用户 profile：`C:\Users\17151\.dsh\profiles\web\`（`package.json` 的 `dsh.profile.bundles`、`cordis.patch.yml`、`settings.yaml`——注意 settings.yaml 其实在 `$DSH_HOME` 即 `C:\Users\17151\.dsh\settings.yaml`）

---

## 0. 结论速览（30 秒版）

1. **推荐架构**：写一个「宿主侧」Cordis 插件（`main: lib/index.js`，导出 `{name, inject, apply, Config}`），随 web profile 挂载进 dsh 主进程（与 3080 GUI 同进程），在 `apply()` 里：
   - 用 `node:http` 自起 **3081** 的 HTTP+WS 服务（或 `ws` 包），托管你自己的页面；
   - 浏览器 RPC 请求经 3081 转发到 **`ctx.get("apiProxy")`**（`dsh-host-apiproxy` 的 service）——`sessions.create / list / history / models / selectModel / prompt / cancel / updateQueue`、`workspace.list` 等；
   - 事件流经 **`apiProxy.events.mux({rpcId, payload}, signal)`** 获得全部会话事件（思考流/工具调用/轨迹/完成），再按 `sessionId` 过滤转发给你的浏览器（WebSocket 或 SSE 均可，参考 remote-web-ui 用 SSE 桥 `apiProxy.events.mux`）。
   - 这就是 **1:1**：所有能力都走同一套 `apiProxy` → `sessions` → `agents` → agent-loop → llm/tools/session 持久化，无任何硬编码。
2. **不要做的事**：不要试图让浏览器直连 `ws://127.0.0.1:3080/api/events.mux` 作为“第二个 Web client” —— 会被信任围栏（Origin/Host 同源校验）拒绝（见 H）。也不要自己重造 session/agent 生命周期 —— 用 `apiProxy` 即可（见 D）。
3. **关键 service 与签名**（全部在宿主 ctx 上，`dsh` 主进程内可用）：
   - `ctx.webServer`（`dsh-host-webserver`）：`register({kind:'exact'|'prefix', path, handler(req,res)})`、`registerUpgrade({path, handler(req,socket,head)})`、`registerFallback`、`tapIndex`、`port`/`host` getter —— **3080 主服务器**，可加路由，但浏览器同源围栏只对 3080 页面友好。
   - `ctx.apiProxy`（`dsh-host-apiproxy`）：`sessions.prompt({rpcId, payload:{sessionId, mode:'queue'|'steer', content:[{type:'text',text}]}})` → `{type:'server-response', rpcId, result:{ok:true, value:{accepted:true}}}`；`events.mux(request, signal): AsyncIterable<RpcRequest<MuxFrame>>`。
   - `ctx.agents` / `ctx.sessions` / `ctx.agentLoop` / `ctx.settings` / `ctx.sessionProjections` / `ctx.tokenMeter` / `ctx.permissionPresets` / `ctx.agentDefaultModel` —— 直接同进程调用的深层接口（见 D/E/F/G）。
4. **WS 端点与鉴权**：主 GUI 的 WS（downlink-only）是 `ws://127.0.0.1:3080/api/events.mux` 与 `/api/events.host`；无 token，靠请求头 Host/Origin 信任围栏（loopback 或 `trustedHosts` 放行）。**跨端口页面直连会被 403**；宿主进程内 Node 侧无 Origin 头可连，但最优解是进程内直接调 `apiProxy.events.mux()`，连网络都省了。
5. **插件装配**：包声明 `dsh.bundle.patch: ./cordis.patch.yml`，patch 内 `- insert: - id: xxx / name: '<你的包名>'`；`dsh plugin --profile web add <包或路径>` = pnpm 装入 profile 目录 + 按“声明了 dsh.bundle 的依赖”自动 reconcile 进 `dsh.profile.bundles`。

---

## A. 插件加载：第三方 Cordis 插件如何加入 dsh web profile

### A.1 机制总览：三层 patch 叠加

dsh 的 profile 是一个「空根配置 + 多层 patch 叠加」的 cordis 树，不是普通 `package.json` 里写死插件列表。根因在 `lib/profile-boot-DG5t9aNs.js`：

```js
// C:\Users\17151\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\profile-boot-DG5t9aNs.js
function composeProfile(name, patchFiles) {
  const profile = prepareProfile(name);                 // 读取 .dsh/profiles/<name>
  const homePatches  = loadOptionalPatches(NAME, homePatchPath()) ?? [];   // $DSH_HOME/cordis.patch.yml
  const overlays     = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));  // --patch
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches); // dsh.profile.bundles 每层 patch
  // 顺序: bundlePatches → profile.patches(profile 的 cordis.patch.yml) → homePatches → overlays → 遥测开关
}
```

`BOOT 顺序`：每个 bundle（在 `dsh.profile.bundles` 数组里）的 `dsh.bundle.patch` 指向的 YAML 是一层；接着是 profile 自己的 `cordis.patch.yml`；再是 `$DSH_HOME/cordis.patch.yml`；最后 `--patch` 覆盖。层内是 cordis loader 的 patch 语义：**按 `id` 覆盖已有行（config 整体替换）、`insert` 插入新行、`disabled: true` 禁用行**。根配置文件 `profiles/web/cordis.yml` 每次 boot 都会被重写为 `[]`（占位，loader 需要真实 include 根）。

### A.2 `dsh.profile.bundles` 与 package.json 的关系

`C:\Users\17151\.dsh\profiles\web\package.json`（本机实况）：

```jsonc
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@linxin666/dsh-client-ui-chat-summary": "github:v833/dsh-chat-summary",
    "@linxin666/dsh-web-ui-all": "^0.1.14",
    "zat-dsh-engine": "github:mishibeikejie/zat-dsh-engine"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",        // 基础层：settings/agents/session/llm/tools 全在
        "@deepseek-ai/dsh-web-app",     // web 面：webserver、frontend-static、connection、api-gateway、全部 ui-*
        "@linxin666/dsh-web-ui-all",    // 全家桶聚合包（自己也是一个 bundle）
        "zat-dsh-engine",
        "@linxin666/dsh-client-ui-chat-summary"
      ]
    }
  }
}
```

要点：
- `bundles` 只放 **声明了 `dsh.bundle.patch` 的包**；`dependencies` 里没声明 `dsh.bundle` 的普通库只装不激活。
- `@linxin666/dsh-web-ui-all` 的 `cordis.patch.yml` 是个巨大 `- insert`，一次性插入所有子插件的行（其中 `- id: remote-web-ui / name: '@linxin666/dsh-remote-web-ui'`），而 `dsh-remote-web-ui` 只是它的依赖。**所以你的插件也可以：要么自己当 bundle 被列入 bundles；要么被某个聚合 bundle 的 insert 引入**。
- 网上/本机插件市场装插件（`@linxin666/dsh-web-ui-all` 全家桶）走的就是这条路。

### A.3 `dsh plugin --profile web add <包或路径>` 的行为

`lib/plugin-9h8shc4d.js`：薄薄一层 pnpm 转发器。

```js
// C:\Users\17151\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\plugin-9h8shc4d.js
function runPlugin(profile, args) {
  const dir = resolveProfileDir(profile);           // C:\Users\17151\.dsh\profiles\web
  if (!existsSync(join(dir, "package.json"))) initProfile(...);   // 首次自动初始化
  const result = spawnSync("pnpm", args.map((a) => anchorPathSpec(a, process.cwd())), {
    cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (exitCode === 0) reconcilePlugins(before, dir);   // 关键：重新算 bundles
  return exitCode;
}
```

`reconcilePlugins` 规则（`exportsPatch` → 检查依赖包 package.json 是否声明 `dsh.bundle.patch`）：
- pnpm 装完后，遍历 profile package.json 的 `dependencies`；**解析到的包若声明了 `dsh.bundle.patch` 就自动追加进 `dsh.profile.bundles`**；没声明的普通依赖只告警不进层。
- 删除/降级后不再声明 bundle 的，从 bundles 移除。
- 相对路径（`.`、`../plugin`、`file:`、`link:`）会被**锚定到用户调用目录**（防在 profile 目录内自链接）。
- 安装行为：本地开发用 `dsh plugin --profile web add link:<你的插件目录>`（或 `file:`）；远程发布后 `add <npm 包名>`。git 来源的包需要 pnpm 的 allowBuilds（有 prepare 脚本时），报错里会提示在 `profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 里加白名单。

### A.4 `cordis.patch.yml` 的作用

两层用户 patch（profile 级 + `$DSH_HOME` 级），是「最终用户改配置」的地方，被 boot 在 bundle 层之后叠加。`profiles/web/cordis.patch.yml` 目前是空数组 `[]`；`C:\Users\17151\.dsh\cordis.patch.yml` 里是 dsh-skin 管理的 `- id: ui-skin-* / disabled: true` 行。**你的插件配置（如端口）也可直接在 profile 的 cordis.patch.yml 写行**，但更推荐用 settings 命名空间（见 G）。

### A.5 插件包需要什么字段（参考 `dsh-remote-web-ui/package.json` 实况）

```jsonc
// C:\Users\17151\.dsh\profiles\web\node_modules\@linxin666\dsh-remote-web-ui\package.json
{
  "name": "@linxin666/dsh-remote-web-ui",
  "version": "0.1.14",
  "type": "module",
  "main": "lib/index.js",                // cordis loader 加载的入口
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }, ... },
  "files": ["lib/**/*.js", "lib/**/*.d.ts", "src", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },        // ◀ bundle 声明，reconcile 的依据
    "client": {                                          // 只有要注入 3080 主 GUI 才需要
      "inject": ["@deepseek-ai/dsh-client-runtime", ...],
      "platform": "web"
    }
  },
  "dependencies": { "schemastery": "^3.18.0", "ws 等按需", ... },
  "peerDependencies": { "react": "^18.2.0", "react-dom": "^18.2.0" }  // 仅客户端 UI 需要
}
```

**关键：`dsh.bundle.patch` 指向的 patch 文件**（`cordis.patch.yml`）把插件自己插进树：

```yaml
# dsh-remote-web-ui/cordis.patch.yml
- insert:
    - id: remote-web-ui                      # cordis 插件行 id（配置定位用）
      name: '@linxin666/dsh-remote-web-ui'   # loader 按此解析 main 并执行 {name,inject,apply,Config}
```

入口模块的“插件形状”（cordis loader 契约，见 `dsh-remote-web-ui/lib/index.js` 末尾）：

```js
const name = "remote-web-ui";
const inject = ["webServer", "apiProxy"];   // 声明依赖 service，loader 先注入再 apply
const Config = z.object({ ... });           // schemastery schema；config 来自 patch 行 config 字段 + settings
function apply(ctx, config) { ... }         // 挂载逻辑，返回 undefined 即可
export { Config, name, apply, inject };
```

不依赖 react 的宿主侧插件不需要 peerDependencies；`type: module` + `main: lib/index.js` 即可。

### A.6 最小自举路径（实操清单）

1. 建好插件目录，写 package.json（含 `dsh.bundle.patch`）、lib/index.js、cordis.patch.yml。
2. `dsh plugin --profile web add link:C:\path\to\plugin`（会 pnpm install + reconcile，自动进 `dsh.profile.bundles`）。
3. 重启 dsh（`dsh web`），`dsh --profile web --dump-config` 可看合成树确认行已插入。
4. 或者手改：`profiles/web/package.json` 的 dependencies 加一行、`dsh.profile.bundles` 加一行，然后 `pnpm install`（等效但绕过了 reconcile 的自动检查）。

---

## B. HTTP 服务挂载：`ctx.webServer` 还是自起 3081

### B.1 `ctx.webServer`（dsh-host-webserver）是什么

`C:\...\dsh-host-webserver\lib\types\index.d.ts`（签名原文）：

```ts
declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }

export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
    kind: WebRouteKind;
    path: string;                                  // 绝对 pathname，无尾斜杠
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
export interface WebUpgradeRoute {
    path: string;
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
export class WebServer extends Service {
    get port(): number;                            // 监听端口（3080 的现值）
    get host(): '127.0.0.1' | '0.0.0.0';
    register(route: WebRoute): () => void;         // 返回 disposer
    registerUpgrade(route: WebUpgradeRoute): () => void;  // WebSocket 升级路由
    registerFallback(handler: WebRoute['handler']): () => void;  // 唯一 fallback（SPA dist）
    tapIndex(transform: (html: string) => string): () => void;
}
```

- 实现（`lib/index.js`）：`node:http` `createServer` + 事件 `upgrade`；按 exact 表 → 最长前缀表 → fallback（404）匹配；重复注册同 (kind,path) 抛错。
- **它和 3080 GUI 是同一个服务器**。web profile 的 webserver 行（`dsh-web-app/cordis.patch.yml` L115-120）：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]                       # 端口/主机来自 CLI --port/--host
  config:
    host: "!!js ctx.webStartup.host ?? '127.0.0.1'"
    port: "!!js ctx.webStartup.port ?? 3080"
```

### B.2 remote-web-ui 怎么用（两个层面的用法都作了示范）

1. **往 3080 主服务器挂路由**：`ctx.webServer.register(...)` 注册 `/m`、`/m/mobile.js`、`/m/api/*`、`/api/pair/*` 等（`kind:"exact"`/`kind:"prefix"`）；**exact 路由先于 connection 的 `/api` prefix 路由匹配**，所以插件能在未被信任围栏覆盖的共用 prefix 上开自己的精确路径。
2. **独立端口自起服务** —— `TunnelManager` 把 `http://127.0.0.1:${ctx.webServer.port}` 通过 cloudflared 暴露公网（`tunnel.start(\`http://127.0.0.1:${String(ctx.webServer.port)}\`)`，index.js L2098），**说明宿主进程内起网服无任何沙箱阻拦**。

### B.3 插件能否直接 `node:http` 自起 3081 —— 推荐方案

**能，且推荐。** 依据：
- dsh 的“沙箱”(`dsh-sandbox` / `dsh-fs-sandbox` / `dsh-bash-sandbox` / `dsh-pwsh-sandbox`) 只约束**agent 工具执行的子进程**（bash/pwsh/fs 的文件副作用、`SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`，见 `dsh-sandbox/lib/types/index.d.ts` L19），**不约束 cordis 宿主进程本身**。插件代码就跑在 `dsh web` 的 node 进程里，`net`/`http`/`ws` 全可用。
- 参考插件远程隧道、cloudflared spawn、`node:child_process` 全在用，证明宿主侧无进程级防火墙。
- 3081 与 3080 无端口冲突；若 3081 被占，用 settings 配置化（G）。

**推荐方案（二选一，均 1:1 复用能力）：**

```
方案 A（推荐）：宿主进程内直连 apiProxy   （最省事、最稳）
  浏览器(3081 页面)
     │  fetch/WS(Same-Origin to 3081)
     ▼
  你的插件 node:http 服务（3081，宿主进程内）
     │  apiProxy.sessions.*  /  apiProxy.events.mux()   ← 同进程直调，无网络、无鉴权问题
     ▼
  dsh 宿主 apiProxy → sessions → agents → agent-loop → llm/tools/stats/settings

方案 B：插件做"第二个 client"桥接 3080
  浏览器(3081) ──WS──▶ 插件(3081) ──ws://127.0.0.1:3080/api/events.mux + POST /api/<method>──▶ dsh
  需要宿主侧起一个 ws 客户端（Node 的 ws 不带 Origin，能过信任围栏）；浏览器本身不能直连 3080（见 H）。
```

A 的每条调用、每个事件都与 GUI 完全同源同路：**模型路由走 `llm` 适配器、权限走 `permission/preset`+`sandbox/mode` 折叠、统计走 session 投影、持久化走 session-persistence-jsonl**，天然 1:1。

---

## C. 客户端↔运行时通信协议

dsh 的通信模型是**“四象限 RPC + 频道与物理载体解耦”**：`dsh-host-apiproxy/lib/types/api/rpc.d.ts` 是权威契约（浏览器可 import，零 Node 依赖）。

### C.1 四种消息（`RpcMessage` 判别联合）

```ts
// dsh-host-apiproxy/lib/types/api/rpc.d.ts
export interface ClientRequest { type: 'client-request'; rpcId: RpcId; method: string; payload: unknown; }
export interface ServerResponse { type: 'server-response'; rpcId: RpcId; result: RpcResult<unknown>; }
export interface ServerRequest  { type: 'server-request';  rpcId: RpcId; method: string; payload: unknown; }
export interface ClientResponse { type: 'client-response'; rpcId: RpcId; result: RpcResult<unknown>; }
// RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }
```

- `client-request`：客户端发起（HTTP POST `/api/<method>` 的 body）。
- `server-response`：对 client-request 的应答（该 POST 的响应 body），rpcId 回显。
- `server-request`：服务器主动（WS 流上的帧；approval/question 请求可应答复用稳定 rpcId，其余是纯推送）。
- `client-response`：对 server-request 的应答（POST `/api/respond` body）。
- `RpcError`：封闭的 `RpcErrorCode` 联合（`session-not-found`、`agent-busy`、`model-unavailable`、`settings-not-exposed`、`internal`…）+ `details` 表（`rpc.d.ts` L26-195）。

### C.2 typert-protocol 的角色

`dsh-typert-protocol` 是 **Service 远程导出/网关的元协议层**（装饰器 `@Remote`、`TypertRemoteService`、`bindTypertRemote`、`typert` lookup/context registry），用于把宿主 service 方法声明成 `<namespace>/<method>` 端点（`lib/types/index.d.ts`）。**它的消息类型就是上面四象限**；具体业务方法面是 `dsh-host-apiproxy/lib/types/api/rpc-map.d.ts`：

```ts
export interface RpcMethodMap {
  'session.list' | 'session.search' | 'session.create' | 'session.history'
  | 'session.models' | 'session.selectModel' | 'session.rename' | 'session.fork'
  | 'session.prompt' | 'session.attachment' | 'session.updateQueue' | 'session.cancel'
  | 'subagent.list' | 'subagent.history' | 'subagent.prompt' | 'subagent.interrupt'
  | 'host.describe' | 'host.pickDirectory' | 'host.listDirectory' | 'host.createDirectory' | 'host.openPath'
  | 'workspace.list' | 'workspace.create' | 'workspace.rename' | 'workspace.delete' | 'workspace.insertBefore'
  | 'workspace.insertSessionBefore' | 'workspace.archiveSession'
  | 'skill.list' | 'agentPreset.list' | 'agentPreset.select' | 'agentPreset.read' | 'agentPreset.copy'
  | 'agentPreset.openDocument' | 'agentPreset.remove'
  | 'goal.create' | 'goal.edit' | 'goal.pause' | 'goal.resume' | 'goal.complete' | 'goal.clear'
  | 'settings.describe' | 'settings.openDocument' | 'settings.update' | 'settings.replace' | 'settings.mutate'
  | 'credentials.describe' | 'credentials.set' | 'credentials.unset'
  | 'llm.providers' | 'llm.models' | 'llm.discoverModels'
}
```

### C.3 client-connection 的 WebSocket 通道（宿主侧）

`dsh-client-connection/lib/index.js`（L467-586）是 `/api` 传输的实际挂载者：

- **路径**：`API_PATH = '/api'`、`MUX_EVENTS_PATH = '/api/events.mux'`、`HOST_EVENTS_PATH = '/api/events.host'`（`lib/types/api-path.d.ts`）。
- HTTP RPC：在 `webServer` 上注册 `{kind:'prefix', path:'/api', handler}` —— 每次请求先过 `isTrustedApiRequest(req, trustedHosts)`（信任围栏，见 H），再按 `clientRequestSchema` 校验 body，`method` 必须与 URL 路径段一致（`POST /api/session.prompt` 的 body.method 必须等于 `session.prompt`）。
- **WS（downlink-only）**：`registerUpgrade` 两个路径，`WebSocketDownlinks` 用 `ws` 的 `WebSocketServer({noServer:true})` 处理 upgrade；握手后 `pump` 通过 `api.events.mux(...)` / `api.events.host(...)` 把帧 `JSON.stringify(serverRequest(frame))` 发给 socket（`send()`，L344-355）。**客户端消息是协议违规**：收到 message 就 `websocket.close(1008, "downlink only")`（L429）。→ 上游永远走 HTTP POST /api。
- 信任围栏实现（`lib/types/api-request-trust.js` L184-198）：

```js
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === void 0) return true;
  return new URL(origin).host === hostUrl.host;   // ◀ 跨端口/跨站 Origin 直接拒绝
}
```

### C.4 api-gateway 的两个面

- **宿主面**（`dsh-api-gateway/lib/index.js`）：`TypertGatewayService`（`super(ctx,"typertGateway")`）在 `connection.rpc` 上 `intercept('/api', claimsEndpoint, dispatchRpc, {authority:'trusted-host'})`，把 `/api/<namespace>/<method>` 派发到实现了对应 Remote 的 Service（含 `dsh-host-apiproxy` 的 `apiProxy`）。payload 必须形如 `{args:{...}}`（L122）。
- **浏览局面**（`dsh-api-gateway/lib/client.js`）：`window.__ModuleLoader__.load(...)` 的浏览器模块，安装 `ctx.remote.<namespace>` service，`invoke` 最终 `connection.rpc.call("/api", endpoint, {args}, signal)`（L256）。**这是给 3080 主 GUI 用的**；你的 3081 页面可以不引入整个 client 运行时，直接按四象限信封 fetch（remote-web-ui 的 mobile.js 就是这么干的：`POST /m/api/<method>` + client-request 信封，L7534-7565）。

### C.5 浏览器能否直连主进程既有 WS？/ 桥接结论

- **3080 页面**：内部就是用 `api.events.mux`（fetch/SSE 载体？不，官方主 GUI 用 WS downlink）+ POST /api。页面与 3080 同源，通过围栏。
- **3081 页面直连 `ws://127.0.0.1:3080/api/events.mux`**：浏览器会带 `Origin: http://127.0.0.1:3081`，`origin.host !== hostUrl.host` → **403 拒绝**（H 详述）。因此**必须经你的插件桥接**：插件宿主侧直调 `apiProxy.events.mux()`（一次性拿全部会话事件流，按需过滤），或宿主侧起 ws 客户端连 3080 的 mux（Node 无 Origin，能过围栏）再转发。前者更简单也更稳。

---

## D. 会话派发：让用户 prompt 真实进入 Agent Loop

三层递进，从“最省事且 1:1”到“最底层”：

### D.1 推荐：`ctx.apiProxy.sessions.prompt(...)`（与 GUI 完全同路径）

宿主侧调用签名（`dsh-host-apiproxy/lib/types/api/sessions.d.ts` L365-376）：

```ts
prompt(request: RpcRequest<{
    sessionId: SessionId;
    mode: 'queue' | 'steer';              // queue = 排入下一轮; steer = 抢占最近 step
    content: PromptContentPart[];          // [{type:'text',text} | {type:'image',mediaType,data(base64),name?}]
    clientTimeZone?: string;               // 可选 IANA 时区，会被校验/规范化
}>): Promise<RpcResponse<{ accepted: true; command?: {kind:'success', text?} }>>;
```

实现路径（`dsh-host-apiproxy/lib/index.js` L2822-2871，MUST-READ）：

```js
async prompt(request) {
  const { sessionId, mode, content, clientTimeZone } = request.payload;
  const resolved = await turnAgentFor(request, sessionId);   // 解析 agent（含 api-remotes 代理场景）
  const agent = resolved.agent;
  const source = { kind: "user", rpcId: request.rpcId, ...(clientTimeZone ? {clientTimeZone} : {}) };
  const message = createUserMessage({ content: await durablePromptContent(ctx, content), source }); // 图片落附件库
  if (mode === "steer") agent.steer(message);
  else agent.followup(message);            // ◀ 排队一轮 + 唤醒 driver，进入 agent-loop
  return ok(request, { accepted: true });
}
```

`agent.followup/steer`（`dsh-agent/lib/types/runtime-types.d.ts` L109-133）：把消息放进 inbox（`UserMessage` + source）并以 `agent/status: running` 唤醒 driver；随后的思考流、工具调用、assistant 消息全都会作为 **session 事件** 出现在 `apiProxy.events.mux()` 流和 `session.history` 里。**一条 `session.prompt` 即完成 GUI “发消息” 的全部语义**（含 slash 命令、图片附件、时间上下文）。

### D.2 网关 client：`dsh-api-gateway/lib/client.js`

`ClientRemoteService` 是浏览器运行时（3080 主 GUI）用的；宿主插件内**不要** import 它的 client.js（它是 `window.__ModuleLoader__` 打包的浏览器产物）。宿主内直接拿 `ctx.get("apiProxy")` 即可 —— 同一个 `createApiProxy(ctx, defaults)` 的实现（`dsh-host-apiproxy/lib/index.js` L5623 起，`super(ctx, "apiProxy")`，inject: `["agentDefaultModel","agents","attachments","directoryPicker","llm","sessions","subagents","sessionQuery","tools","userQuestions","workspaceRegistry"]`）。

### D.3 最底层：直接操作 `ctx.agents` / `ctx.agentLoop` / `ctx.sessions`（需要时再看）

- `ctx.sessions`（`dsh-session`）：`create(id?, opts?)`、`prepare/enter/announce`（复合生命周期）、`get(id)`、`list()`、`fork(source, boundary?, childId?)`、`flush(session)`；`session.append(type, data, surfaceOp?)`、`session.events`、`session.deriveMessages()`、`session.surface`。
- `ctx.agents`（`dsh-agent`）：`get(id)`、`list()`、`create(CreateAgentOptions)` / `resume(ResumeAgentOptions)`（需 `ctx.agentLoop` 装了 factory）、`setFactory`。
- `ctx.agentLoop`（`dsh-agent-loop`）：`create(id, options, meta?)` 等。
- 自定义驱动层接口：`agent.send(message, target: InboxTarget, wakeup)`、`agent.followup`、`agent.steer`、`agent.inject`、`agent.cancel(cause, {keepInbox})`、`agent.whenIdle()`。

**两套方案对比表**

| 方案 | 用法 | 优点 | 缺点 |
|---|---|---|---|
| ① 插件直调 apiProxy（推荐） | `ctx.get('apiProxy').sessions.prompt(...)` + `events.mux()` | 与 GUI 完全同语义；零网络/零鉴权；一张口覆盖 create/history/models/rename/cancel/queue；命令、图片、时区都处理好了 | 无独立鉴权层（3081 页面的访问控制要自己做，如 remote-web-ui 的配对 cookie / token） |
| ② HTTP/WS 中转（4080 style） | 插件起 ws 客户端连 `ws://127.0.0.1:3080/api/events.mux` + `POST /api/<method>` | 跨进程/远程部署时能复用现成协议；浏览器可直连 | 多一跳、要自己实现 envelope 编解码与 rpcId 关联；页面直连 3080 仍被 Origin 围栏挡（N/A 给 3081 页面） |

---

## E. 事件订阅：思考流、工具调用、轨迹、完成

### E.1 最佳入口：`apiProxy.events.mux(...)`（聚合全会话事件流）

`dsh-host-apiproxy/lib/types/api/events.d.ts` L44-55：

```ts
events: EventsApi;
// StreamsApi 原样：
mux(request: RpcRequest<{ since?: Record<SessionId, number> }>, signal: AbortSignal):
    AsyncIterable<RpcRequest<MuxFrame>>;
host(request: RpcRequest<{}>, signal: AbortSignal):
    AsyncIterable<RpcRequest<HostFrame>>;
```

`MuxFrame` 判别联合（events.d.ts L66-145），关键几支：

```ts
type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }  // 原始会话事件（思考流/工具/消息全在这）
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }   // 流打开时的基线
  | { type: 'approval/requested'; sessionId; approvalId; toolName: string; callId?; reason? }      // 权限审批（answerable server-request）
  | { type: 'approval/resolved'; sessionId; approvalId; outcome }
  | { type: 'question/requested'; sessionId; questions: AskUserQuestionItem[] }  // ask_user 问题（answerable）
  | { type: 'question/resolved'; sessionId; questionRpcId; outcome }
  | { type: 'session/queue'; sessionId; items: QueuedInboxItem[] }          // 待处理队列快照
  | { type: 'session/jobs'; sessionId; jobs: JobView[] }                    // 后台任务快照
  | { type: 'session/projection'; sessionId; key: string; value: unknown; seq: number }  // 投影值变更（标题/统计等）
  | { type: 'stream/error'; error: RpcError };
```

WS 载体上每帧被包成 `server-request`：`{type:'server-request', rpcId, method: frame.payload.type, payload: frame.payload}`（`dsh-client-connection/lib/index.js` L336-343）。

**spot 用法（remote-web-ui 的 SSE 桥，index.js L1145-1192）**：

```js
const frames = apiProxy.events.mux({ rpcId: RpcId(`mobile-mux-${Date.now().toString(36)}`), payload: {} }, controller.signal);
for await (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);   // SSE 逐帧转发
```

宿主插件同理：`for await (const frame of apiProxy.events.mux({rpcId,payload:{}}, signal))` 取流，按 `sessionId` 过滤后经自己的 WS/SSE 送给 3081 页面。

### E.2 会话事件词汇（轨迹/思考/工具/完成都在 session 事件里）

`dsh-session/lib/types/known-event-types.js` L18-63 完整枚举（43 个）：

```
agent-preset/selected  agent/inbox/spliced  approval/asked  approval/decided  approval/policy
assistant/chunk  assistant/message  command/done  command/run  compaction/end  compaction/prune
compaction/start  compaction/summary  feedback/record  goal/change  hook/invoked  hook/result
llm/retry  llm/retry-started  permission/preset  plan/mode  request/context  request/header
sandbox/mode  schedule/change  session/end-seed  session/title  session/title-llm-request
step/end  step/start  subagent/descriptor  todo/write  tool-workflow/*  tool/call  tool/result
turn/end  turn/start  user/message  web/deepseek-search-llm-request
```

- 一轮 = `turn/start` … `turn/end`；一步 = `step/start` … `step/end`；
- 思考流 = `assistant/chunk`（`data.chunk` 带 `type: 'delta'|'block-start'|'block-end'` 等，块可含 `thinking`/`text`/`tool-call` 子块）；
- 工具 = `tool/call` → `tool/result`（`callId` 配对上屏）；完成 = `assistant/message`（携带 `data.usage`、`data.model` 等）+ `turn/end`。

`SessionEvent` 信封（`dsh-session/lib/types/types.d.ts` L420-452）：

```ts
type SessionEvent = {
  type: K; seq: number; time: number;              // seq=log 长度递增；time=Unix ms
  data: SessionEventMap[K];
  ignorable?: true;                                 // 未知类型可跳过标记
  // 仅 surface 事件（user/message、assistant/message、tool/result）额外有：
  sourceEventSeqs?: number[]; surfaceOp?: 'append' | {op:'replace'; start:number; end:number};
}
```

### E.3 直接订阅宿主级 cordis 事件（同进程插件也常见）

`dsh-session`（`lib/types/index.d.ts` Events 声明）：
- `session/created` / `session/disposed` / `session/event`（`(session, event)` post-commit 推送）/ `session/flush`（并行 durabiliity barrier）。
`dsh-agent`（`runtime-types.d.ts` Events）：
- `agent/created`、`agent/disposed`、`agent/status`（idle/running）、`agent/inbox/inserted|claimed|discarded`、`agent/session-start`、`agent/pre-step`(waterfall)、`agent/request`(waterfall)、`agent/request-error`、`agent/turn-stopping`(serial)、`agent/error`。
同进程插件可直接 `ctx.on('session/event', ...)` 或 `ctx.on('agent/status', ...)` 拿对象引用（比 mux 流更“近”，但注意 scope-filtered：session/agent 事件带 scope，普通宿主 ctx 监听需要 scope 匹配；对外转发优先用 apiProxy.events.mux）。

### E.4 历史读取与投影缓存

- **`apiProxy.sessions.history({sessionId, beforeSeq?, maxMessages?})`** → `{events: HistoryEntry[], hasMore, projections?}`：每项 `{event, view?}`；分页按消息边界对齐；尾页带 `projections`（基线块）。
- **`ctx.sessionProjections`**（`dsh-session-projection/lib/types/index.d.ts`）：注册 `ProjectionDefinition`（key/schema/init/apply/view/stateVersion）；`snapshot(session)` 同步读一致切面（`ProjectionSnapshot {asOfSeq, values}`）；`onChanged(listener(session,key,value,seq))` 变更流；`checkpoint/restore/restoreFloor/viewCheckpoint` 冷读（持久化投影缓存行）。`session/history` 的 `projections` 就是 `sessionProjections.snapshot()` 的 wire 化（`asOfSeq`/`values`）。
- 投影键（web profile 已注册）：`sessionStats`（dsh-session-stats，见 F）、`sessionListMetadata`/`imageLimits`（host-apiproxy 声明）、`tokenUsage`/`contextPressure`/`contextBreakdown`（dsh-token-meter）、`permissions`（permission-presets）、标题类等。`session/projection` 帧实时推送变更。

---

## F. 统计与模型

### F.1 `sessionStats` 投影（dsh-session-stats）

`dsh-session-stats/lib/types/types.d.ts` L18-35 —— 字段名（全 0 起，均从完整事件日志折叠，与页面统计条同源）：

```ts
export interface SessionStatsProjection {
  turns: number;        // 含至少一个 step/end 的不同轮数
  steps: number;        // step/end 数（完成/失败/取消都算）
  llmMs: number;        // step/start → assistant/message 的模型墙钟时间合计
  toolMs: number;       // tool/call → tool/result（按 callId 配对）耗时合计
  ttftMs: number;       // 首 token 延迟合计（step/start → 首个非空 delta chunk）
  ttftSteps: number;    // 记录了首 token 的步数
  decodeMs: number;     // 解码墙钟（首 token → assistant/message）
  decodeTokens: number; // 同解码计时步上的 provider 输出 token
}
```

**从哪拿**：`apiProxy.sessions.history` 尾页 `projections.values['sessionStats']`，或同进程 `ctx.sessionProjections.snapshot(session).values.sessionStats`，或订阅 `session/projection` 帧（key=`sessionStats`）。无需硬编码任何值——全部来自实时折叠。

### F.2 token 用量（dsh-token-meter）

- Service：`ctx.tokenMeter`（`dsh-token-meter/lib/types/index.d.ts`），`measure(session, requestHeader?)` → `TokenMeasurement`（`types.d.ts` L23-36）：

```ts
interface TokenMeasurement {
  logRevision: number;            // 已消费事件数（= 下一个未读 seq）
  baseline: {kind:'none'|'estimated'|'usage'; tokens:number; usage?: TokenUsage};  // provider 用量锚
  surfaceDeltaTokens: number;     // 相对锚的当前表面增量
  totalTokens: number;            // 当前请求+响应压力
  surfaceTokens: number;          // 当前表面总 token
  nodes: readonly {seq:number; tokens:number}[];   // 逐节点 token 价
}
```

- 投影键（`usage-projection.d.ts` / `breakdown-projection.d.ts`）：`tokenUsage`（每轮的 provider 上报用量：输入/输出 token、缓存命中随 `TokenUsage` 结构由 dsh-llm 定义）、`contextPressure`（`contextWindow`/`pressureTokens`/`surfaceTokens`/`sampledSurfaceTokens`）、`contextBreakdown`（`systemTokens`/`toolsTokens`/`messageTokens`）。
- 宿主侧还可直接从 session 事件读 `data.usage`（`assistant/message` 的 usage 块：`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` 等，字段在 `dsh-llm` 的 `TokenUsage`，随 provider 上报）。不硬编码：全部取当前会话真实上报。

### F.3 模型枚举与切换

- **枚举（会话态）**：`apiProxy.sessions.models({sessionId})` → `{current: ModelSelection, routable: boolean, groups: ModelProviderGroup[], failures: [...]}`；`ModelProviderGroup {id,name,models:[{id,name,description?,reasoning?:{efforts,defaultEffort}}]}`（`sessions.d.ts` L92-162）。`routable` 是“此会话现在能否起一轮”的权威标志。
- **枚举（宿主态）**：`apiProxy.llm.models({})` 同结构无会话；`apiProxy.llm.providers({})` 给可配置 provider 拓扑；`llm.discoverModels` 探测未配置端点（loopback 特权方法）。
- **切换**：`apiProxy.sessions.selectModel({sessionId, provider, model, reasoningEffort?})` → `{selected}`；持久化默认走 `ctx.agentDefaultModel`（`currentSelection()`/`saveSelection()`, `dsh-agent/model-selection.d.ts`）。
- 实现源头：`dsh-host-apiproxy` 的 `buildModelCatalog`（index.js L1068）遍历 `ctx.llm.listProviders()` + `listModels` + `resolveModelInfo` —— 也就是**当前已注册适配器（deepseek-official / pi-ai 自定义 provider 等）的真实目录**，不在插件里硬编码模型名。

### F.4 权限预设 / 沙箱模式 / 会话“模式”

- **权限预设**（`dsh-permission-presets`）：`ctx.permissionPresets`；`names`、`defaultPreset`、`current(events)`、`selectFor(state)`、`set(session, name)`。预设表默认 `workspace-write(+ask)`、`danger-full-access(+never)`（即 Web UI 的“Full Access”）；会话级 `permission/preset` + `sandbox/mode` + `approval/policy` 事件折叠为 `permissions` 投影（`KnobState {preset, sandbox, approval}`）。web 面预设 `ui-permission` 用 `session.models` 旁的 `permissions` 投影渲染选择器。
- **沙箱模式**：`SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`（`dsh-sandbox/lib/types/index.d.ts` L19）；每会话覆盖写 `sandbox/mode` 事件（`dsh-sandbox-policy/session-mode.d.ts` `setSandboxMode(session, mode)`、`effectiveSandboxMode(events)`）。
- **会话 Agent“模式”（标准/创造/梁神…）= agent preset**：`apiProxy.agentPresets.list({})` → `{presets:[{id,trust,isDefault,name?,description?,broken?}], authorable, hasDocument}`；`session.create({agentPreset})` 指定；`apiProxy.agentPresets.select({sessionId, agentPreset})` 只能在 blank 会话上换。本机 shipped presets：`standard`（标准模式）、`code`、`cordis`、`minimal` + 用户 `liangshen`（`config/agent-presets/*/preset.yml` 的 `name:` 即 UI 显示名）。这是“模式”的唯一正确入口。

---

## G. 沙箱与配置

### G.1 `ctx.settings`（dsh-settings）—— 插件自己的配置存哪

`dsh-settings/lib/types/index.d.ts`（核心签名）：

```ts
declare module '@deepseek-ai/cordis' { interface Context { settings: SettingsProvider } }

register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T>;
// SettingsScope<T>: get(): T; watch(cb(next,prev)); update(patch): Promise<void>; replace(section): Promise<void>;
describe(options?: {redactSecrets?: boolean}): SettingsDescriptor[];
update/replace/mutate(ns, patch|section|ops, expectedRevision?): Promise<void>;   // 串行化写队列 + 乐观并发
installSettingsSection(ctx, ns, schema, entry, hooks);   // 插件标准接法：合并 entry(config) + settings 双源
```

命名空间规范 `settingsNamespace()`：`/^[a-z][a-z0-9-]*$/`（kebab-case，如 `remote-web-ui`、`agent-loop`、`shell`）。

**落盘**：`dsh-settings-file`（base 层已挂，`dsh-base/cordis.patch.yml` L78-79）持久化到 **`$DSH_HOME/settings.yaml`**（`resolveSpec`，`lib/index.js` L31：`resolve(config.path ?? join(resolveDshHome(config.dshHome), "settings.yaml"))`；yaml 保留注释的 leaf-diff 写入 + chokidar 热重载）。本机 `C:\Users\17151\.dsh\settings.yaml` 实样：

```yaml
ui-onboarding: { welcomeNoticeVersion: 2026-08-13.1 }
llm-pi-ai: { providers: { opencode-go: { apiKeyEnv: OPENCODE_GO_API_KEY } } }
agent-default-model: { provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: max }
ui-theme: { preference: dark }
shell: {}
pet: { visible: true, size: 160, right: 67, bottom: 81, name: 鲸鱼娘 }
```

**插件端口放哪？** 推荐：注册命名空间 `govui`（或插件名），schema 用 `z.object({ host: z.string().default('127.0.0.1'), port: z.natural().default(3081), token: z.string().role('secret') ... })`，`installSettingsSection` 挂到 entry config（cordis.patch.yml 的 config 字段）之上 —— 用户在 GUI 设置页或 settings.yaml 改，宿主插件 `watch()` 热生效。**注意** `WEB_SETTINGS_NAMESPACES`（host-apiproxy index.js L888-896）只暴露固定名单给 Web 设置页（`agent-loop/shell/locale/permission/ui-conversation/ui-theme/web-search-deepseek`），新命名空间默认不会出现在 3080 设置页 —— 若不介意，你的配置页面自己写在 3081 里即可；若想在 3080 设置页出现，需要 host-apiproxy 侧加名单（deferred work，见注释）。

### G.2 LocalStorage 无冲突

LocalStorage 是**浏览器端存储**（你的 3081 页面自用）；宿主侧的 settings/session 持久化不存在 LocalStorage。3081 页面用 LocalStorage 存自己的 UI 状态、配对 token 等完全没有冲突。主 GUI(3080) 的 LocalStorage 键空间（如 dsh.taskBoard.v1）与 3081 页面互不相干（不同 origin）。

---

## H. 主进程 WS 端点：web-app / host-apiproxy / client-connection 三者的关系

### H.1 关系图

```
dsh web（宿主进程，port 3080，node:http createServer）
├─ dsh-host-webserver  = ctx.webServer（注册表 + upgrade 分发；唯一 HTTP/WS 服务器）
│   ├─ exact/prefix 路由（各插件 register 的路由；exact 优先）
│   ├─ frontend-static 作为 fallback（SPA dist，dsh-web-app 装入）
│   └─ upgrade 路由：
│         /api/events.mux   ← dsh-client-connection 注册的 WebSocketDownlinks
│         /api/events.host  ← 同上
├─ dsh-host-apiproxy  = ctx.apiProxy（transport-agnostic 实现；不注册任何路由）
│     sessions/workspace/host/skills/agentPresets/goals/settings/credentials/llm/events/downloads/respond
└─ dsh-client-connection = ctx.connection
      ├─ prefix /api 路由：信任围栏 isTrustedApiRequest → clientRequest 校验 → 派发到
      │     api-gateway 的 typertGateway interceptor（声称 /api 端点的 Service，即 apiProxy）
      └─ WebSocketDownlinks：升级后逐帧发送 server-request 包装的 mux/host 帧（downlink-only）
```

- `dsh-web-app`：web 面胶水（frontend-static fallback、surface prompt、URL 打印、`webStartup` CLI 解析 `--host/--port/--trusted-host`）。端口 3080 来自 `ctx.webStartup.port ?? 3080`。
- `dsh-host-apiproxy`：纯契约+实现，不碰网络；物理载体（connection 的 HTTP/WS、fetch 桥、进程内直调）包它。
- `dsh-client-connection`：Web 载体的唯一挂载者（/api HTTP + 两个 WS downlink）。

### H.2 WS 端点与鉴权

- 端点：`http://127.0.0.1:3080/api/events.mux`、`/api/events.host`（WebSocket upgrade；GET 请求会回 426 Upgrade Required）。**无 token、无 cookie 鉴权**；防护 = 信任围栏：
  - Host 头必须是 loopback（`localhost`、`127/8`、`[::1]`）或在 `trustedHosts` 中（`connection` 行 config，web profile 由 `webRuntime.trustedHosts` = LAN IP 推导 + `--trusted-host` 扩展）；
  - `sec-fetch-site: cross-site` 拒绝；
  - 带 `Origin` 时必须 `origin.host === hostUrl.host`（同源）。
- **特权方法**（`PRIVILEGED_METHODS`，index.js L504-520：`settings.*`、`credentials.*`、`agentPreset.read/copy/openDocument/remove`、`host.pickDirectory/openPath`、`llm.discoverModels`）在任何部署下都按**空信任列表**（仅 loopback）过围栏。

### H.3 结论：3081 页面能否当“第二个 client”直连？

**不能（浏览器侧）**：页面在 `http://127.0.0.1:3081`，浏览器 WS/fetch 会带 `Origin: http://127.0.0.1:3081`（fetch 带 `<sec-fetch-site>`），与 3080 的 host 不同 → 围栏 403。**但宿主 Node 侧（ws 库）可行**（不自动带 Origin）—— 若坚持“第二 client”方案，由插件进程起 ws 客户端转发。

**最省事且 1:1 的最终方案（再次强调）**：插件与 dsh 宿主同进程 → 直接 `ctx.get("apiProxy")` 调用 + `apiProxy.events.mux()` 消费，浏览器 3081 页面只与插件自身通信。这既绕开围栏，又复用 100% 的会话/模型/权限/统计能力。

---

## 附 I. 关键消息 JSON 示例

```jsonc
// 1) 浏览器 → 3081 → apiProxy.sessions.prompt（queue = 正常发问）
{
  "type": "client-request",
  "rpcId": "8f3a2c1e-...",
  "method": "session.prompt",
  "payload": {
    "sessionId": "session-7ab3d1f2",
    "mode": "queue",
    "content": [{ "type": "text", "text": "调研 dsh 集成面并写文档" }],
    "clientTimeZone": "Asia/Shanghai"
  }
}
// 应答：
{ "type": "server-response", "rpcId": "8f3a2c1e-...", "result": { "ok": true, "value": { "accepted": true } } }

// 2) mux 流上的真实事件帧（WS/SSE 逐帧）
{ "type": "server-request", "rpcId": "pull-uuid-1",
  "method": "session/event",
  "payload": { "type": "session/event", "sessionId": "session-7ab3d1f2",
    "event": { "type": "user/message", "seq": 41, "time": 1748000000000,
      "data": { "message": { "role": "user", "content": [{ "type": "text", "text": "调研 dsh 集成面并写文档" }] }, "source": { "kind": "user", "rpcId": "8f3a2c1e-..." } },
      "surfaceOp": "append" } } }

// 3) 思考流/工具调用/完成（事件都要做时序/聚屏处理）
{ "type": "server-request", "rpcId": "u2", "method": "session/event",
  "payload": { "type": "session/event", "sessionId": "s1",
    "event": { "type": "step/start", "seq": 42, "time": 1748000000100, "data": { "turn": 2, "step": 4 } } } }
{ "type": "server-request", "rpcId": "u3", "method": "session/event",
  "payload": { "type": "session/event", "sessionId": "s1",
    "event": { "type": "tool/call", "seq": 43, "time": 1748000000200,
      "data": { "callId": "call-1", "tool": "web_search", "args": { "query": "..." } } } } }
{ "type": "server-request", "rpcId": "u4", "method": "session/event",
  "payload": { "type": "session/event", "sessionId": "s1",
    "event": { "type": "assistant/message", "seq": 60, "time": 1748000005000,
      "data": { "message": { "role": "assistant", "content": [{ "type": "text", "text": "……" }] },
                "usage": { "inputTokens": 1200, "outputTokens": 340, "cacheReadTokens": 0 } },
      "sourceEventSeqs": [43, 59], "surfaceOp": "append" } } }

// 4) 投影帧（统计/标题等实时推送）
{ "type": "server-request", "rpcId": "u5", "method": "session/projection",
  "payload": { "type": "session/projection", "sessionId": "s1", "key": "sessionStats", "seq": 60,
    "value": { "turns": 2, "steps": 5, "llmMs": 4200, "toolMs": 1300, "ttftMs": 700, "ttftSteps": 5, "decodeMs": 3500, "decodeTokens": 340 } } }
```

## 附 II. 推荐架构图（ASCII）

```
┌──────────────────────────── dsh web 宿主进程（node, port 3080）─────────────────────────────┐
│                                                                                              │
│  cordis 树（profile layers: dsh-base + dsh-web-app + 你的插件 bundle + ...）                    │
│                                                                                              │
│  ┌─ ctx.webServer (dsh-host-webserver, 3080 main server) ────────────────────────────────┐   │
│  │  /api  prefix (client-connection) ── trust fence ── typertGateway ─▶ ctx.apiProxy    │   │
│  │  /api/events.mux|.host  WS downlinks ──(server-request 帧)──▶ apiProxy.events.*       │   │
│  │  frontend-static fallback (3080 主 GUI dist)                                          │   │
│  └──────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                              │
│  ┌─ 你的插件（宿主侧, apply() 内）─────────────────────────────────────────────────────────┐   │
│  │  ┌─ node:http server（独立 3081）────────────────┐    ┌─ for await (frame of            │   │
│  │  │  GET /         → 你的页面（html+js bundle）   │    │     ctx.apiProxy.events.mux(     │   │
│  │  │  POST /api/rpc  → dispatch(apiProxy, ...)    │    │       {rpcId,payload:{}},sig))   │   │
│  │  │  WS /events     ← 转发 session/projection 帧 │    │   ── sessionId 过滤 ──▶ WS/SSE   │   │
│  │  └───────────────┬──────────────────────────────┘    └──────────────────────────────────┘   │
│  │                  │  sessions.create/list/history/models/selectModel/prompt/cancel/...      │
│  │                  ▼                                                                          │
│  │  ctx.apiProxy ──▶ sessions(SessionStore) ──▶ agents(AgentRegistry) ──▶ agent-loop(ReactLoop)│
│  │                        │ session 事件流               │ agent/status / agent/request 等     │
│  │                        ▼                             ▼                                      │
│  │  session-persistence-jsonl / projections(sessionStats, permissions, tokenUsage...)         │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘
│                                                                                              │
│  宿主 service: settings(settings.yaml) / tokenMeter / permissionPresets / sessionProjections   │
│  / agentDefaultModel / llm(适配器: deepseek-official, pi-ai 自定义) / sandbox-policy           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ 1:1（同一进程、同一会话/模型/权限/统计，无任何硬编码）
        │
┌───────┴───────────────────────────┐
│ 浏览器 3081 页面（独立 origin）      │
│  LocalStorage 自用 / fetch+WS 与 3081 插件通信 │
└───────────────────────────────────┘
```

## 附 III. 避坑清单

1. **不要**给浏览器开放 3080 直连（围栏会拒绝跨端口 Origin）；也不要试图绕围栏 —— 宿主进程内直调 apiProxy 是官方通道。
2. **不要把** api-gateway 的 `lib/client.js`（`window.__ModuleLoader__` 浏览器产物）import 进宿主插件；宿主侧用 `ctx.get('apiProxy')`。
3. **不要在插件里硬编码模型/预设/权限/统计字段**：模型 = `sessions.models`/`llm.models`；权限 = `permissionPresets` + `permissions`/`sandbox/mode` 折叠；统计 = `sessionStats`/`tokenUsage`/`tokenMeter.measure`；模式 = `agentPreset.list`。
4. **3081 要有自己的访问控制**（配对 token / 同源 cookie，参考 remote-web-ui 的 `dsh_pair` cookie + `api/gate`）：3080 的围栏不覆盖你的 3081 服务（除非你把页面挂到 3080 的 webServer 路由上）。
5. **端口冲突**：settings 配置化 3081；监听失败要让 `apply()` 显式报错（宿主 fail-loud 会打印）。
6. `api/gate` waterfall（remote-web-ui 用的应用层访问控制钩子）在本机 rc.6 的 `dsh-client-connection` 中**未发布**（remote-web-ui 针对更新的源码构建）；不要依赖它，需要时自己实现等价拦截。
7. 浏览器 → 插件的 RPC 信封建议 100% 复用四象限格式（client-request/server-response + rpcId），这样移动端/未来官方客户端可直接互通。
8. 会话事件流要按 `sessionId` 过滤并处理 `session/subscribed`(基线 `lastSeq`) 与 `session.history` 的 `projections`(asOfSeq) 以正确接续历史（断线重连 = 重开流 + 重拉历史，`since` 参数 v1 未实现）。