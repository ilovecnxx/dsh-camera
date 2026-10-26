# dsh-camera — 设计说明与协作契约

> 目标：DSH Web 插件。电脑上打开某个对话 → 点输入框下方「拍照上传」→ 弹出二维码/链接 →
> 局域网手机扫码打开手机网页 → 拍照或从相册选图 → 图片**直接作为该对话的 user 消息**
>（带 image 附件）注入，手机无需装 App，图片立即可见、模型可直接看图。
>
> 运行环境：DSH 0.2.1-rc.3，web profile，GUI http://127.0.0.1:3080（本机 LAN IP 10.10.10.10）。
> 仓库（本目录）`dsh-camera/` 以 `link:` 方式安装进 profile，**Host 半不得 import 任何
> `@deepseek-ai/*` 或第三方 npm 包**（link 安装没有 node_modules），只能用 Node 内置模块与
> `./lib/*` 相对导入；Client 半在浏览器里由 DSH ModuleLoader 加载，只能 `require('react')`
> / `require('react-dom')`，禁止 JSX 构建步骤（手写 `h()`）。

## 一、已确认的关键技术事实（不要再重复调研）

1. **注入对话的正确入口**：Host 插件直接调用 `ctx.sessionController.prompt(request, signal)`。
   - `request`：`{ sessionId, requestId: <uuid>, mode: 'queue', content: PromptContentPart[] }`
   - `content` 图片项：`{ type: 'image', mediaType: 'image/jpeg', data: <canonical base64>, name? }`
   - 它会做模型多模态能力校验、图片归一化/限流、附件持久化、`source={kind:'user',rpcId}`、
     `agent.followup(message)` 入队并唤醒。**这是内部方法，但本版本可直接调用**
     （`principalOf(undefined invocation)` 安全返回 undefined；spike 负责最终确认）。
   - 失败抛 `RemoteError`（`code`/`message`/`details`）：常见 `session/not-found`、
     `session/attachment-invalid`（details.reason 如 `MODEL_DOES_NOT_SUPPORT_IMAGES`、
     `IMAGE_TOO_LARGE`、`IMAGE_TYPE_MISMATCH`）、`gateway/bad-request`。
   - 兜底路径（若上述不可用）：`ctx.sessionController.resolveAgent(id)` → `ctx.attachments.saveImage({data,mediaType,name})`
     → 手工构造 `{id: crypto.randomUUID(), role:'user', content:[{type:'image',attachment:ref}], source:{kind:'user'}}`
     → 深冻结后 `agent.followup(message)`。
2. **图片限制（默认）**：单图 ≤ 20 MiB、≤ 64e6 像素、边长 ≤ 8192；支持 PNG/JPEG/WebP/GIF。
   **手机端不压缩、不缩放**，原图字节直接上传；唯一例外是 HEIC/HEIF：DSH 不支持，
   浏览器先解码成全分辨率 JPEG（quality 0.98）再上传。超过 20 MiB 的原图在手机端直接提示。
   **视频**：DSH 只能把图片送进模型视觉输入，视频走「文件附件」通道（`FileAttachmentRef`，
   原样保存、不转码）；模型收到文件名/大小/可读取保存路径，不能直接观看视频。
3. **客户端插件与 Host 的 RPC**：Host 在半边 `ctx.webServer.register({kind:'prefix', path:'/dsh-camera', handler})`
   挂一个 JSON RPC 通道；用 `ctx.connection.requestRejection(req)` 做浏览器鉴权（返回 401/403 即拒绝）。
   Client 端用 `ctx.connection.rpc.call('/dsh-camera', '<endpoint>', payload)` 调用。
   wire 格式必须与 dsh-client-connection 对齐：
   - 请求：`POST /dsh-camera/<endpoint>`，`content-type: application/json`，
     body `{ type:'client-request', rpcId, method:'<endpoint>', payload }`
   - 响应：HTTP 200，body `{ type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error} }`
   - endpoint 段只允许 `[A-Za-z0-9_$.-]+`
4. **Client 半会话身份**：`conversation.composer.dock` 是 session 作用域 list slot，
   组件 props 里有 `sessionId`、`useSession`、`useSessions`（全局标准 props）、`useProjection`、`t`。
5. **插件清单**：`package.json` 中
   ```json
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": { "platform": "web", "immediately": true,
       "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-conversation"] }
   }
   ```
   `cordis.patch.yml`：`- insert:\n    - id: dsh-camera\n      name: '@local/dsh-camera'`
   （可选 `config:` 传端口等，无 Config schema 时原样传给 `apply(ctx, config)`）。
6. **不要碰**：3080 上正在运行的 `dsh web` 进程（本会话就住在里面）。测试一律用隔离
   `DSH_HOME=/tmp/dsh-cam-home` + 独立端口（3099），用完 kill 自己启动的 PID。
7. 已安装参考实现可读（不要复制源码，dsh-pocket 是 GPL）：
   `~/.dsh/profiles/web/node_modules/dsh-pocket/lib/web-rpc.js`（RPC 桥接思路）、
   `.../dsh-pocket/lib/service.mjs`（0.0.0.0 监听）、
   `default-workspace/balance-pill/client.js`（composer dock + portal 面板 + 样式写法）。

## 二、目录与文件归属（写作用域，互不越界）

```
dsh-camera/
├── package.json          [Lead]
├── cordis.patch.yml      [Lead]
├── index.js              [Lead]  Host 入口：装配 config/tokens/server/injector/rpc，注册 webServer 路由，卸载清理
├── lib/
│   ├── config.js         [Lead]  resolveConfig(raw, env)
│   ├── inject.js         [Lead]  createInjector({ctx, log}) → {validateSession, deliver}
│   ├── rpc.js            [Lead]  installRpcRoute({ctx, webServer, connection, tokens, injector, server...})
│   ├── qr.js             [Lead]  renderQrPath(text) → {size, path}
│   ├── vendor/qrcode.cjs [Lead]  MIT vendor (qrcode-generator)
│   ├── lan-ip.js         [A]     pickLanIp(override) → string|null；lanCandidates()
│   ├── tokens.js         [A]     class TokenStore（见契约）
│   ├── multipart.js      [A]     readMultipart(req, opts)、sniffImageType(buf)
│   ├── server.js         [A]     startCameraServer(opts)（见契约）
│   └── page.js           [A]     renderCameraPage(info) → HTML 字符串
├── client.js             [B]     浏览器半：dock 按钮 + 门户面板（二维码/链接/状态）
├── locale/{zh,en}.json   [B]     插件元数据（设置→插件列表显示用）
├── tests/unit-*.test.mjs [A/C]   单元测试（node --test）
├── tests/*.test.mjs      [C]     server/inject/rpc 契约测试
├── scripts/              [C]     隔离 profile 启动 / Chrome CDP E2E
├── verification/         [C]     截图、日志等验证产物
├── README.md             [Lead]
└── DESIGN.md             [Lead]
```

## 三、模块契约（实现必须严格匹配，跨模块以本文件为准）

### 3.1 config.js

```js
export const DEFAULTS = {
  enabled: true,            // 插件加载即启动 LAN 服务器
  port: 3579,               // 0 = 随机端口；被占用时自动回退随机端口（记录实际端口）
  bindHost: '0.0.0.0',
  lanIpOverride: '',
  tokenTtlMs: 2 * 60 * 60 * 1000,   // 链接有效期 2h
  maxUploadBytes: 96 * 1024 * 1024, // 单次请求总字节上限（照片+视频）
  maxImageBytes: 20 * 1024 * 1024,  // 单图上限（不压缩，仅校验；DSH 硬限制）
  maxVideoBytes: 80 * 1024 * 1024,  // 单个视频上限（原样保存）
  maxRecordSeconds: 60,     // 页面内录像最长秒数（HTTPS 全屏相机）
  maxFilesPerUpload: 6,
  uploadsPerHour: 120,      // 每 token 每小时上传次数上限
  https: false,             // 可选 HTTPS 监听（getUserMedia 全屏相机需要 secure context）
  httpsPort: 0,             // HTTPS 端口；0 = HTTP 实际端口 + 1
};
export function resolveConfig(rawConfig, env = process.env) → {
  ...DEFAULTS, stateDir /* $DSH_HOME/dsh-camera 或 ~/.dsh/dsh-camera */,
  debug: env.DSH_CAMERA_DEBUG === '1',
}
```
`rawConfig` 来自 cordis.patch.yml `config`，可为 undefined。数字字段做合法性兜底。

### 3.2 lan-ip.js

```js
export function lanCandidates(interfacesFn = os.networkInterfaces, defaultRouteFn = () => null)
  → [{address, iface, score, defaultRoute, narrow}]
// 过滤 internal、IPv6、非 10/8、172.16/12、192.168/16 的地址；
// 排序优先级：默认路由网段（defaultRoute）> 非 /30、/31、/32 窄网段（narrow）>
//            私网段偏好 192.168 > 10 > 172 > 地址数值 > 网卡名
export function detectDefaultRouteIp() → string | null
// Linux: `ip -4 route show default` 里的 src 地址（10s 缓存）；失败/其他平台返回 null
export function pickLanIp(override, interfacesFn?, defaultRouteFn = detectDefaultRouteIp) → string | null
// override 是合法 IPv4 则直接返回；否则取 candidates[0]?.address ?? null
```

> 这个排序是必需的：本机存在 USB 共享/点对点网段（如 `192.168.77.1/30`）时，
> 只按私网段偏好会把它排在 Wi-Fi 前面，生成手机不可达的链接。

### 3.3 tokens.js

```js
export class TokenStore {
  constructor({ file, ttlMs, maxTokens = 16, now = Date.now })
  async load()                    // 读文件；损坏/缺省视为空；顺带 prune
  arm({ sessionId, title })       // 该 session 有未过期 token 则复用，否则新建；返回 entry
  armNew({ sessionId, title })    // 强制新建（旧 token 保留至过期/被 disarm）
  get(token)                      // → entry | null（过期/未知 → null，并 prune）
  disarm(token)                   // → boolean
  recordUpload(token, info)       // → entry|null；info={filename,ok}; entry.uploads++
  recent(limit = 10)              // → [{token, sessionId, title, at, filename, ok}] 最近上传记录
  status()                        // → {tokens: <未过期数量>}
  async flush()                   // 原子写（先写 temp 再 rename），文件 mode 0600；失败只 log
}
```
entry 形状：`{ token, sessionId, title, createdAt, expiresAt, uploads, lastUploadAt }`。
token = `crypto.randomBytes(18).toString('base64url')`（24 字符）。持久化 JSON：`{version:1, tokens:{...}, recent:[...]}`（recent 最多 50 条）。
`title` 仅用于展示，host 不校验其内容；长度截断 120。

### 3.4 multipart.js

```js
export async function readMultipart(req, { maxBytes = 24*1024*1024, maxFiles = 6 })
// → { fields: {name: string}, files: [{ fieldName, filename, mediaType, data: Buffer }] }
// 支持：
//  a) content-type: multipart/form-data; boundary=...（浏览器 FormData）
//  b) content-type: image/* 或 application/octet-stream → 单文件，filename 取 x-filename
//     header（decodeURIComponent 后）或缺省 'photo.jpg'
// 超限抛错：err.code='too-large'（在读取过程中即中断并 drain/destroy），非法请求 err.code='bad-request'
export function sniffImageType(buf) → 'image/jpeg'|'image/png'|'image/webp'|'image/gif'|null
export function sniffVideoType(buf) → 'video/mp4'|'video/quicktime'|'video/webm'|'video/x-m4v'|'video/3gpp'|null
export function sniffMedia(buf) → { kind: 'image'|'video', mediaType } | null
// 按魔数识别 MP4/MOV/M4V（ISO BMFF ftyp）、WebM/Matroska（EBML）；不信任 Content-Type。
```
安全：不信任 filename 路径；不落盘；字段名/文件名仅做展示用清洗（去控制字符、截断 80）。

### 3.5 inject.js（Lead 实现，A/C 只消费）

```js
export function createInjector({ ctx, config, log }) → {
  // 校验目标会话可注入（arm 时调用）；不唤醒会话
  async validateSession(sessionId) → { ok: true, sessionId, title?: string }
                                  | { ok: false, code: 'session/not-found'|'internal', message }
  // 把一批已通过 sniff/大小检查的图片注入对话；一次上传 = 一条 user 消息（多图一条）
  async deliver({ sessionId, files }) // files:[{kind:'image'|'video', data:Buffer, mediaType, filename}]
    → { ok: true, requestId, count }
    | { ok: false, code, message }    // code 透传 RemoteError.code，details.reason 合并进 message
```
- 图片：content 用 `{type:'image', mediaType, data:base64, name}`。
- 视频：`ctx.fileUploads.uploadStream({sessionId, data, name, signal})` → `receiptId`，
  content 用 `{type:'file', receiptId}`（Host 的 prompt admission 会 resolve 成 durable
  `FileAttachmentRef`）；没有 `fileUploads` 时兜底 `ctx.attachments.saveFileStream()` + 手工消息。
- 图片+视频可在同一条消息里按选择顺序混排。
}
```

### 3.6 server.js（A 实现）

```js
export async function startCameraServer({
  config,            // 3.1 的 resolved config
  tokens,            // 3.3 实例（已 load）
  injector,          // 3.5
  log = console,
  version = '0.0.0',
  lanCandidatesFn,   // 可注入，便于单测（默认 os.networkInterfaces）
}) → {
  port,              // 实际监听端口
  host,              // 实际 bindHost
  lanIp,             // 3.2 结果，可能 null
  startedAt,
  buildUrl(token),    // → `http://<lanIp>:<port>/c/<token>`；无 lanIp 时用 127.0.0.1 并标记 localOnly
  info(),             // → {running, port, httpPort, lanIp, localOnly, startedAt, version,
                      //     warning, httpsEnabled, httpsPort, httpsWarning, setupUrl, caFingerprint}
  buildHttpsUrl(token), // HTTPS 相机页（httpsEnabled 时），否则 null
  stop(): Promise<void>,
}
```
HTTP 路由（全部 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`）：

| Method | Path | 行为 |
|---|---|---|
| GET | `/` | 302 → `/c/invalid`（无 token；页面显示友好提示） |
| GET | `/c/:token` | token 有效 → 200 HTML（`page.js`）；无效/过期 → 410 HTML 提示页（中文/英文） |
| GET | `/c/:token/info` | JSON `{ok:true, value:{title, expiresAt, uploads, serverTime, version, lang}}`；无效 → 404 `{ok:false,error:{code:'invalid-token'}}` |
| POST | `/c/:token/upload` | 读 multipart → `sniffMedia` 分诊（图片/视频）+ 按 kind 校验大小/数量 → injector.deliver → JSON `{ok:true, value:{count, expiresAt, uploads}}`；失败 → 4xx/5xx JSON `{ok:false,error:{code,message}}`（code: invalid-token / too-large / image-too-large / video-too-large / bad-request / no-image / rate-limited / inject-failed:<code>） |
| GET | `/setup` | 证书安装引导页（HTTPS 全屏相机首次配置；手机打开） |
| GET | `/ca.mobileconfig` | iOS 配置描述文件（内嵌本地 CA，安装后信任） |
| GET | `/ca.crt` | CA 证书 PEM（Android/其他系统安装） |
| GET | `/favicon.ico` | 204 |
| 其他 | * | 404 文本 |

其他要求：`server.on('clientError')` 优雅 400；`server.requestTimeout = 120000`；
每 token 每小时上传次数限制（`uploadsPerHour`），超限 429；
`token` 正则 `^[A-Za-z0-9_-]{16,64}$`；HTML/JSON 都带 `Content-Security-Policy`（HTML 页允许内联）：
`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'`。
端口占用（EADDRINUSE）：若 config.port !== 0，回退 port 0 并记录 `listenWarning`；再失败则抛错（由 index.js 捕获并记录，面板可显示）。

### 3.7 page.js（A 实现）

```js
export function renderCameraPage({
  token, title, expiresAt, serverTime, version,
  lang,               // 'zh' | 'en'（由 Accept-Language 决定）
  maxFiles,           // 单次发送上限（默认 6，来自 config.maxFilesPerUpload）
}) → string           // 完整 HTML 文档
```
要求（移动优先，无外部资源，内联 CSS/JS）：
- 顶部：标题「拍照上传 / Photo upload」+ 目标对话名（`title`，过长省略）+ 有效期倒计时。
- 主操作：`<button>拍照</button>`（隐藏 `<input type="file" accept="image/*" capture="environment">`）
  + `<button>从相册选择</button>`（`<input type="file" accept="image/*" multiple>`）。
- **手动发送**：选图/拍照后只做本地压缩与预览，**不自动上传**；缩略图带每张状态
  （压缩中/待发送/上传中/已发送/失败重试）+ 单张「重试」；底部固定「发送 N 张」主按钮
  （`data-cam-send`，无待发送时禁用，文案带数量）与「清空」（`data-cam-clear`）。
  用户可连续「拍照」多次、跨多次选择累积待发送照片（上限 `maxFiles`，默认 6），
  确认后点发送一次性上传为一条 user 消息。
- **不压缩**：图片原样上传；仅 HEIC/HEIF 由浏览器解码后转全分辨率 JPEG（0.98）；
  超过 `maxImageBytes` 或解码失败给出中英文提示。视频原样保存，不转码。
- 视频入口：`data-cam-video-btn`（HTTP 模式调系统相机录像/`<input capture>`）；
  相册输入接受 `image/*,video/*`；HTTPS 全屏相机内可切「录像」模式
  （`data-cam-mode-video`、MediaRecorder、`data-cam-record-time`，默认最长 `maxRecordSeconds` 秒）。
- 点发送时把全部待发送照片 → 一次 `POST /c/<token>/upload`（FormData，字段名 `photo`，可多个）。
- 成功：绿色「已发送到对话」+ 累计计数；失败：红色错误文案 + 重试按钮；token 过期（410）→ 明确提示「请在电脑上重新打开拍照面板」。
- 可访问性：`lang` 属性、按钮 aria-label、`prefers-color-scheme` 深色适配、`env(safe-area-inset-*)`。
- 全屏相机（可选，仅 `window.isSecureContext` 时）：拍照按钮打开 `data-cam-camera` 覆盖层，
  `<video>` 实时取景、`data-cam-shutter` 连拍（canvas → JPEG → 待发送列表）、`data-cam-flip` 切换镜头、
  `data-cam-camera-close` 关闭；**代码从不请求 torch/闪光灯**，也不做屏幕补光。
  非 secure context 时拍照按钮回退系统相机（`capture` input），并在页面显示 HTTPS 引导（`data-cam-secure-hint`）。
- 上传进度：XHR `upload.onprogress` 驱动 `data-cam-progress` 进度条与状态文案。
- 测试锚点（E2E 用）：`data-cam-page`、`data-cam-input-capture`、`data-cam-input-gallery`、
  `data-cam-status`（值 `idle|working|done|error`）、`data-cam-count`、`data-cam-error`、
  `data-cam-send`（按钮，`data-cam-send-count`=待发送张数）、`data-cam-send-label`、
  `data-cam-clear`、`body[data-cam-pending]`（待发送张数，0 表示没有）。
- 页面 JS 只用 fetch + FormData + canvas + URL.createObjectURL；不依赖任何 CDN。

### 3.8 RPC 契约（Lead 实现 rpc.js，B 消费）

通道 `/dsh-camera`，`ctx.connection.rpc.call('/dsh-camera', endpoint, payload)`；
成功值在 `result.value`，失败 `result.error = {code, message, details}`。

| endpoint | payload | value |
|---|---|---|
| `camera.status` | `{}` | `{ server:{running, port, lanIp, localOnly, warning}, config:{port, tokenTtlMs}, version }` |
| `camera.arm` | `{ sessionId, title?, rotate?: true }` | `{ token, url, qr:{size,path}, expiresAt, sessionId, title, lanIp, server:{port} }` |
| `camera.disarm` | `{ token }` | `{ disarmed: boolean }` |
| `camera.recent` | `{ limit?: number }` | `{ uploads:[{sessionId, title, at, filename, ok}] }` |

错误 code：`session/not-found`、`no-lan-address`、`server-unavailable`、`bad-request`。
`camera.arm` 语义：没有服务器/LAN IP → 相应错误；`rotate:true` 强制新 token；
同一 session 重复 arm 返回同一 token（有效期不延长）。`qr.path` 是 SVG path `d` 属性，
坐标系每模块 1 单位，客户端 `<svg viewBox="0 0 \${size} \${size}"><path d fill="currentColor"/></svg>`。

### 3.9 client.js（B 实现）

- `window.__ModuleLoader__.load({ id: '@local/dsh-camera', factory(require) {...} })`，
  `inject = ['slots', 'locale', 'connection']`；`ctx.slots.inject('conversation.composer.dock', ...)`
  注册 `{ name:'conversation.composer.dock', id:'camera-upload', order: 3, locale: 'camera-upload' }`。
- Dock 按钮：相机 SVG 图标 + 文案「拍照上传 / Photo upload」，样式跟随 DSH 主题变量
  （参考 balance-pill/client.js 的 `--dsw-*` 用法），小屏只显示图标。
- 点击 → `createPortal` 到 `document.body` 的固定定位面板（宽 320，锚定在按钮上方，
  自动夹在视口内，点击外部/Escape 关闭）：
  - 标题「手机拍照上传」+ 关闭按钮；
  - 二维码（从 `camera.arm` 的 `qr` 渲染，200×200；`data-dsh-camera-qr`）；
  - 链接文本 + 「复制链接」按钮（clipboard API + execCommand 兜底）；
  - 三步说明：「手机连同一 Wi-Fi → 扫码打开 → 拍照即发送」；
  - 目标对话名、链接剩余有效期（倒计时）、已接收 N 张照片（`camera.recent` 每 3s 轮询，
    仅面板打开时）；
  - 操作：「换一个链接」（rotate arm）、「在手机浏览器打开」（展示 URL 文本）；
  - 状态/错误行（服务器未启动、无局域网地址等，显示具体错误 message）。
- 打开面板时自动 `camera.arm({sessionId, title})`；`sessionId` 来自 props；
  title 从 `useSessions()`/`useSession()`/props 推导，兜底「当前对话 / Current chat」。
- 中英文词典：`ctx.locale.register('camera-upload', {en, zh})`，组件用 `t`。
- 所有网络失败都要 catch 并显示，不允许抛到 React 边界。
- 测试锚点：`data-dsh-camera-dock`、`data-dsh-camera-panel`、`data-dsh-camera-url`、
  `data-dsh-camera-qr`、`data-dsh-camera-count`、`data-dsh-camera-error`。

### 3.10 依赖注入（Host index.js 的 inject 列表）

`inject = ['webServer', 'connection', 'sessionController', 'attachments', 'fileUploads']`。
- `webServer`：挂 `/dsh-camera` 前缀 RPC 路由；
- `connection`：`requestRejection(req)` 浏览器鉴权；
- `sessionController`：`prompt()` 注入 + `inspect()` 校验目标会话；
- `attachments`：读取部署图片限制（`imageLimits`，inject.js 内仍 try/catch 兜底）、视频兜底 `saveFileStream`；
- `fileUploads`：视频以 staged receipt 形式进入 prompt（`uploadStream` → `{type:'file', receiptId}`）。

四个服务缺失（非 web 组合）→ 插件保持未加载即可。
`ctx.effect()` 管理 LAN server 与 RPC 路由的卸载；`server.stop()` 必须在插件卸载时 await/触发。

## 四、测试与验证（C 负责）

1. **单元测试**（`node --test tests/`，零外部依赖；QR 解码测试可用 /tmp 下临时 npm 安装的 `jsqr`，
   缺失则 skip）：
   - tokens：arm 复用/rotate/过期/get/disarm/recordUpload/持久化 reload/损坏文件容错。
   - multipart：手工构造 multipart body（多文件、中文文件名）、超限、raw image body、sniff 各格式。
   - lan-ip：注入假 networkInterfaces 验证过滤与排序。
   - qr：对 `http://10.10.10.10:3579/c/<token>` 生成 path，栅格化后用 jsqr 解码回原文（可选 skip）。
   - server：`port:0` 启动 + fetch 打真端口：页面 200、失效 token 410、info JSON、
     upload 用假 injector 验证成功/失败/超限/429、CSP/头检查。
   - inject：mock ctx（sessionController.prompt 捕获参数）验证 base64/requestId/错误映射。
2. **隔离 profile E2E**（`scripts/e2e.mjs`，Chrome 已在 `/usr/bin/google-chrome`）：
   - 建临时 `DSH_HOME=/tmp/dsh-cam-home`，profile `cam` bundles=`[dsh-base, dsh-web-app, @local/dsh-camera]`，
     `dsh plugin --profile cam add link:<repo>`，启动 `dsd --profile cam --no-open --port 3099`（后台 job），
     从日志取带 token 的 URL；
   - Chrome headless（CDP over 127.0.0.1 debug port，Node 24 有全局 WebSocket）：
     打开 GUI → 新建对话（点「New Session/新会话」或 composer 直接发一句）→
     点 `[data-dsh-camera-dock]` → 从 `[data-dsh-camera-url]` 读 LAN URL →
     新标签打开该 URL → CDP `DOM.setFileInputFiles` 给 `[data-cam-input-gallery]` 塞测试 PNG
     → 断言不自动上传（pending=N、upload 请求 0）→ 点 `[data-cam-send]` →
     等 `[data-cam-status="done"]` 且 `data-cam-count>=1` →
     回 GUI 标签等对话里出现图片消息（`img` 或 `[data-*]`）→ 截图存 `verification/`；
   - 测试图片用 Node `zlib` 手写最小 PNG（不依赖 sharp）。
   - 断言失败必须非零退出；结束后 kill 自己启动的 dsh 与 chrome，不碰 3080。
3. **最终验收**（Lead 执行）：真实 web profile 安装后 `dsh --profile web --dump-config` 含本插件行、
   3080 仍 200/401 正常、插件客户端 bundle 可被 GUI 加载、隔离 E2E 全绿。

## 五、协作规则

- 只改自己作用域内文件；跨模块需要改契约时**先改本文件**（DESIGN.md 由 Lead 维护，
  A/B/C 不要改 DESIGN.md，把需求写进给 Lead 的消息）。
- 每个模块先写接口骨架再实现；写完自己跑 `node --check`（或 `node --test` 自己那部分）。
- 消息汇报格式：完成什么 / 改了哪些文件 / 自测结果 / 阻塞点 / 需要 Lead 决策的点。
- 遇到契约歧义：以本文件为准；本文件没写的，按「最小实现 + 汇报」处理。
