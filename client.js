/**
 * dsh-camera — Client half (browser plugin, no build step).
 *
 * A camera entry below the composer opens a floating panel that asks the Host
 * half (`/dsh-camera` unary RPC channel) for a one-time LAN token, shows the
 * QR code / link and polls how many photos the phone already delivered.
 *
 * Contract: DESIGN.md 3.8 (RPC endpoints) and 3.9 (this file).
 * Only `react` / `react-dom` may be required; everything below is plain
 * `React.createElement` — no JSX, no bundler.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-camera',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const Fragment = React.Fragment;

    /** Dictionary namespace owned by this plugin (registered via ctx.locale). */
    const NS = 'camera-upload';
    /** Host half's unary RPC channel, see DESIGN.md 3.8. */
    const CHANNEL = '/dsh-camera';
    /** Panel width in CSS pixels; clamped to the viewport when it is narrower. */
    const PANEL_WIDTH = 320;
    /** QR bitmap edge in CSS pixels (DESIGN 3.9: 200x200). */
    const QR_EDGE = 200;
    /** `camera.recent` polling cadence while the panel is open. */
    const RECENT_POLL_MS = 3000;
    /** How many recent uploads the panel asks for. */
    const RECENT_LIMIT = 50;
    /** How long the "copied" / "copy failed" feedback stays on the button. */
    const COPY_FEEDBACK_MS = 2000;
    /** Countdown turns amber below this threshold. */
    const EXPIRING_SOON_MS = 5 * 60 * 1000;

    // ------------------------------------------------------------------
    // Dictionaries (flat key/value, see LocaleDict)
    // ------------------------------------------------------------------

    const en = {
      dockLabel: 'Photo upload',
      dockAria: 'Upload a photo from your phone',
      panelTitle: 'Upload from phone',
      panelSubtitle: 'Scan with your phone to send photos straight into this chat.',
      close: 'Close',
      loading: 'Creating a link…',
      loadingHint: 'Checking the local network service.',
      qrAria: 'QR code that opens the phone upload page',
      qrUnavailable: 'The QR code could not be rendered. Open the link below on your phone instead.',
      stepsTitle: 'How it works',
      step1: 'Connect your phone to the same Wi-Fi as this computer.',
      step2: 'Scan the QR code, or open the link below on your phone.',
      step3: 'Take or pick a photo — it is sent to this chat automatically.',
      metaChat: 'Chat',
      metaExpires: 'Link expires in',
      metaReceived: 'Photos received',
      metaReceivedUnit: '',
      expiresExpired: 'Expired',
      copy: 'Copy link',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      copyHint: 'Select the link above and copy it manually.',
      openInPhone: 'Open on phone',
      fullUrlHint: 'Open this address in your phone browser:',
      fullUrlAria: 'Full phone upload link',
      rotate: 'New link',
      rotating: 'Creating a new link…',
      retry: 'Retry',
      currentChat: 'Current chat',
      blankHint: 'This is a new chat — the first photo you send becomes its first message.',
      warningNotice: 'Notice: {message}',
      errServerUnavailableTitle: 'The LAN service is not running',
      errServerUnavailableHint: 'Restart DSH, or enable the dsh-camera plugin, then try again.',
      errNoLanTitle: 'No LAN address found',
      errNoLanHint: 'Connect this computer to Wi-Fi or a wired LAN, or set lanIpOverride in the plugin config.',
      errSessionNotFoundTitle: 'This chat is unavailable',
      errSessionNotFoundHint: 'Open a chat again, then reopen this panel.',
      errBadRequestTitle: 'The request was rejected',
      errBadRequestHint: 'Reload the page and try again.',
      errTransportTitle: 'Could not reach the camera service',
      errTransportHint: 'Check that the dsh-camera plugin is installed and enabled, then reload the page.',
      errUnknownTitle: 'Could not create the link',
      errUnknownHint: 'Try again in a moment.',
    };

    const zh = {
      dockLabel: '拍照上传',
      dockAria: '用手机拍照上传',
      panelTitle: '手机拍照上传',
      panelSubtitle: '用手机扫码，照片会直接发送到当前对话。',
      close: '关闭',
      loading: '正在生成链接…',
      loadingHint: '正在检查局域网服务。',
      qrAria: '打开手机上传页面的二维码',
      qrUnavailable: '二维码渲染失败，请改用下方链接在手机上打开。',
      stepsTitle: '使用方法',
      step1: '手机连接与电脑相同的 Wi-Fi。',
      step2: '扫描二维码，或在手机浏览器打开下方链接。',
      step3: '拍照或选择照片，自动发送到当前对话。',
      metaChat: '目标对话',
      metaExpires: '链接有效期',
      metaReceived: '已接收',
      metaReceivedUnit: '张',
      expiresExpired: '已过期',
      copy: '复制链接',
      copied: '已复制',
      copyFailed: '复制失败',
      copyHint: '请选中上方链接手动复制。',
      openInPhone: '在手机浏览器打开',
      fullUrlHint: '请复制以下地址，在手机浏览器中打开：',
      fullUrlAria: '完整的手机上传链接',
      rotate: '换一个链接',
      rotating: '正在生成新链接…',
      retry: '重试',
      currentChat: '当前对话',
      blankHint: '这是新对话，手机发来的第一张照片会成为该对话的第一条消息。',
      warningNotice: '提示：{message}',
      errServerUnavailableTitle: '局域网服务未启动',
      errServerUnavailableHint: '请重启 DSH，或确认 dsh-camera 插件已启用后重试。',
      errNoLanTitle: '未检测到局域网地址',
      errNoLanHint: '请确认电脑已连接 Wi-Fi 或有线网络，或在插件配置中设置 lanIpOverride。',
      errSessionNotFoundTitle: '当前对话不可用',
      errSessionNotFoundHint: '请重新打开一个对话，然后再次打开此面板。',
      errBadRequestTitle: '请求被拒绝',
      errBadRequestHint: '请刷新页面后重试。',
      errTransportTitle: '无法连接拍照服务',
      errTransportHint: '请确认 dsh-camera 插件已安装并启用，然后刷新页面重试。',
      errUnknownTitle: '无法生成链接',
      errUnknownHint: '请稍后重试。',
    };

    // ------------------------------------------------------------------
    // Small pure helpers (kept hook-free so they are easy to reason about)
    // ------------------------------------------------------------------

    /** A hook stand-in used when the slot environment did not hand one over. */
    function noopHook() {
      return undefined;
    }

    /** Coerce an unknown value to a string without ever throwing. */
    function asText(value) {
      return typeof value === 'string' ? value : '';
    }

    /** Best-effort human readable text for an exception or payload. */
    function readableError(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object') {
        const message = asText(error.message);
        if (message !== '') return message;
        try {
          const serialized = JSON.stringify(error);
          return serialized === undefined || serialized === '{}' ? '' : serialized;
        } catch (jsonError) {
          return '';
        }
      }
      return '';
    }

    /** Normalize the Host's `{code, message, details}` failure shape. */
    function normalizeRpcError(error) {
      const source = error && typeof error === 'object' ? error : {};
      const details =
        source.details && typeof source.details === 'object' && Array.isArray(source.details) === false
          ? source.details
          : undefined;
      return {
        code: asText(source.code) || 'unknown',
        message: asText(source.message) || readableError(source),
        details,
      };
    }

    /**
     * Validate the `camera.arm` value so an unexpected payload can never break
     * rendering. Returns null when the value is unusable.
     */
    function normalizeArmValue(value) {
      if (!value || typeof value !== 'object') return null;
      const rawQr = value.qr && typeof value.qr === 'object' ? value.qr : null;
      const qrSize = rawQr === null ? NaN : Number(rawQr.size);
      const qrPath = rawQr === null ? '' : asText(rawQr.path);
      const rawExpires = value.expiresAt;
      let expiresAt = NaN;
      if (typeof rawExpires === 'number') expiresAt = rawExpires;
      else if (typeof rawExpires === 'string' && rawExpires !== '') expiresAt = Date.parse(rawExpires);
      const rawPort = value.server && typeof value.server === 'object' ? Number(value.server.port) : NaN;
      return {
        token: asText(value.token),
        url: asText(value.url),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        sessionId: asText(value.sessionId),
        title: asText(value.title),
        lanIp: asText(value.lanIp),
        port: Number.isFinite(rawPort) ? rawPort : 0,
        qr: Number.isFinite(qrSize) && qrSize > 0 && qrPath !== '' ? { size: qrSize, path: qrPath } : null,
      };
    }

    /** Zero-pad a number to two digits. */
    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    /**
     * Format a remaining duration as `mm:ss` (or `h:mm:ss` when at least an
     * hour is left). Expired or unknown durations read `00:00`.
     */
    function formatRemaining(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '00:00';
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
    }

    /** Count the successful uploads that belong to one session. */
    function countSessionUploads(uploads, sessionId) {
      if (Array.isArray(uploads) === false || asText(sessionId) === '') return 0;
      let count = 0;
      for (const item of uploads) {
        if (!item || typeof item !== 'object') continue;
        if (item.sessionId !== sessionId) continue;
        if (item.ok === false) continue;
        // One upload row can carry a multi-photo batch; older hosts omit it.
        const images = Number(item.count);
        count += Number.isFinite(images) && images > 0 ? images : 1;
      }
      return count;
    }

    /** Build the `camera.arm` payload without leaking empty title strings. */
    function buildArmPayload(sessionId, title, rotate) {
      const payload = { sessionId };
      const known = asText(title).trim();
      if (known !== '') payload.title = known.slice(0, 120);
      if (rotate === true) payload.rotate = true;
      return payload;
    }

    /**
     * Derive the target chat name from the sessions list snapshot: durable
     * title first, then the display label (workspace basename), never the raw
     * blank-session placeholder.
     */
    function selectSessionTitle(state, sessionId) {
      if (asText(sessionId) === '') return undefined;
      if (!state || typeof state !== 'object') return undefined;
      const rows = state.byId;
      if (!rows || typeof rows !== 'object') return undefined;
      const row = rows[sessionId];
      if (!row || typeof row !== 'object') return undefined;
      const title = asText(row.title).trim();
      if (title !== '') return title;
      const display = asText(row.displayTitle).trim();
      if (display !== '' && row.blank !== true) return display;
      return undefined;
    }

    /** Localized title + hint for one RPC failure code (DESIGN 3.8). */
    function errorCopy(tr, error) {
      const code = error && asText(error.code) ? error.code : 'unknown';
      switch (code) {
        case 'server-unavailable':
          return { title: tr('errServerUnavailableTitle'), hint: tr('errServerUnavailableHint') };
        case 'no-lan-address':
          return { title: tr('errNoLanTitle'), hint: tr('errNoLanHint') };
        case 'session/not-found':
          return { title: tr('errSessionNotFoundTitle'), hint: tr('errSessionNotFoundHint') };
        case 'bad-request':
        case 'gateway/bad-request':
          return { title: tr('errBadRequestTitle'), hint: tr('errBadRequestHint') };
        case 'transport':
        case 'bad-response':
          return { title: tr('errTransportTitle'), hint: tr('errTransportHint') };
        default:
          return { title: tr('errUnknownTitle'), hint: tr('errUnknownHint') };
      }
    }

    /**
     * Copy text through the async Clipboard API, falling back to a hidden
     * textarea + execCommand for insecure contexts / older browsers.
     */
    async function copyText(text) {
      const value = asText(text);
      if (value === '') return false;
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (clipboard && typeof clipboard.writeText === 'function') {
        try {
          await clipboard.writeText(value);
          return true;
        } catch (clipboardError) {
          // Fall through to the legacy path below.
        }
      }
      if (typeof document === 'undefined' || !document.body) return false;
      let area;
      try {
        area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.left = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, value.length);
        return typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false;
      } catch (fallbackError) {
        return false;
      } finally {
        if (area && typeof area.remove === 'function') area.remove();
      }
    }

    // ------------------------------------------------------------------
    // RPC facade: every failure is normalized, nothing ever throws
    // ------------------------------------------------------------------

    /** Create the `{call}` facade consumed by the dock/panel components. */
    function createCameraApi(ctx) {
      const call = (endpoint, payload, signal) => {
        const connection = ctx && ctx.connection ? ctx.connection : undefined;
        const rpc = connection && connection.rpc ? connection.rpc : undefined;
        if (!rpc || typeof rpc.call !== 'function') {
          return Promise.resolve({
            ok: false,
            error: { code: 'server-unavailable', message: 'Connection RPC is unavailable.', details: undefined },
          });
        }
        return Promise.resolve()
          .then(() => rpc.call(CHANNEL, endpoint, payload, signal))
          .then((result) => {
            if (result && result.ok === true) return { ok: true, value: result.value };
            if (result && result.ok === false) return { ok: false, error: normalizeRpcError(result.error) };
            return { ok: false, error: { code: 'bad-response', message: 'Unexpected RPC response.', details: undefined } };
          })
          .catch((cause) => {
            const aborted = (signal !== undefined && signal !== null && signal.aborted === true) ||
              (cause && cause.name === 'AbortError');
            if (aborted) return { ok: false, aborted: true, error: { code: 'aborted', message: '', details: undefined } };
            return {
              ok: false,
              error: { code: 'transport', message: readableError(cause), details: undefined },
            };
          });
      };
      return { call };
    }

    /** Never throw inside a component: route calls through the facade. */
    function safeCall(api, endpoint, payload, signal) {
      if (!api || typeof api.call !== 'function') {
        return Promise.resolve({
          ok: false,
          error: { code: 'server-unavailable', message: 'Camera RPC is unavailable.', details: undefined },
        });
      }
      try {
        return Promise.resolve(api.call(endpoint, payload, signal));
      } catch (error) {
        return Promise.resolve({ ok: false, error: { code: 'transport', message: readableError(error), details: undefined } });
      }
    }

    // ------------------------------------------------------------------
    // Icons (inline SVG, currentColor)
    // ------------------------------------------------------------------

    function cameraIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M4.6 8.4h2.5l1.35-1.95a1 1 0 0 1 .82-.45h5.46a1 1 0 0 1 .82.45L16.9 8.4h2.5A1.5 1.5 0 0 1 20.9 9.9v7.5a1.5 1.5 0 0 1-1.5 1.5H4.6a1.5 1.5 0 0 1-1.5-1.5V9.9a1.5 1.5 0 0 1 1.5-1.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 12, cy: 13.2, r: 3.1, stroke: 'currentColor', strokeWidth: 1.6 }),
      );
    }

    function closeIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M7 7l10 10M17 7L7 17',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    function copyIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('rect', {
          x: 8.5,
          y: 8.5,
          width: 11,
          height: 11,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    function phoneIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('rect', {
          x: 7,
          y: 3,
          width: 10,
          height: 18,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('path', { d: 'M10.5 17.5h3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    function rotateIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M19.5 4.5V8h-3.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function errorIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M12 7.8v5.4',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 12, cy: 16.4, r: 1, fill: 'currentColor' }),
      );
    }

    function warningIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M12 4.5 20.5 19h-17L12 4.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M12 10v4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 16.4, r: 1, fill: 'currentColor' }),
      );
    }

    // ------------------------------------------------------------------
    // Panel (only mounted while open; owns the whole network state machine)
    // ------------------------------------------------------------------

    /**
     * Floating panel with the QR code, link, countdown and upload counter.
     *
     * State machine:
     * - mount -> `camera.arm` -> ready (qr/link) | error (localized copy + Host message)
     * - ready -> 1s countdown + 3s `camera.recent` poll
     * - ready -> "New link" -> `camera.arm({rotate:true})` -> ready (keeps the old
     *   QR visible while busy; a rotation failure keeps the working link and adds
     *   an error line)
     * - error -> "Retry" -> arm again (full reload of the state)
     * - unmount -> abort in-flight requests, clear timers (never setState after)
     */
    function CameraPanel(props) {
      const { api, sessionId, blank, t, anchorRef } = props;
      const onClose = props.onClose;
      const knownTitle = props.title;
      const tr = (key, params) => (typeof t === 'function' ? t(key, params) : key);

      const [phase, setPhase] = React.useState('loading'); // loading | ready | error
      const [data, setData] = React.useState(null); // normalized arm value
      const [error, setError] = React.useState(null); // normalized RPC failure
      const [busy, setBusy] = React.useState(false); // rotation in flight (old QR kept)
      const [reloadKey, setReloadKey] = React.useState(0); // retry counter for the arm effect
      const [uploads, setUploads] = React.useState([]); // camera.recent uploads
      const [now, setNow] = React.useState(() => Date.now());
      const [warning, setWarning] = React.useState(''); // camera.status server warning
      const [copyState, setCopyState] = React.useState('idle'); // idle | copied | failed
      const [showFullUrl, setShowFullUrl] = React.useState(false);
      const [pos, setPos] = React.useState(undefined);

      const panelRef = React.useRef(null);
      const fullUrlInputRef = React.useRef(null);
      const mountedRef = React.useRef(false);
      const abortRef = React.useRef(null);
      const seqRef = React.useRef(0);
      const copyTimerRef = React.useRef(0);
      const onCloseRef = React.useRef(onClose);
      const titleRef = React.useRef(knownTitle);
      onCloseRef.current = onClose;
      titleRef.current = knownTitle;

      // Lifetime: track mounting and tear everything down on unmount.
      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          if (abortRef.current !== null) {
            try {
              abortRef.current.abort();
            } catch (abortError) {
              // An already-aborted controller is harmless.
            }
            abortRef.current = null;
          }
          if (copyTimerRef.current !== 0) {
            window.clearTimeout(copyTimerRef.current);
            copyTimerRef.current = 0;
          }
        };
      }, []);

      // Arm a token whenever the panel mounts or the user hits Retry.
      React.useEffect(() => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current = controller;
        const seq = seqRef.current + 1;
        seqRef.current = seq;
        setPhase('loading');
        setData(null);
        setError(null);
        setBusy(false);
        setCopyState('idle');
        setShowFullUrl(false);
        void (async () => {
          const result = await safeCall(
            api,
            'camera.arm',
            buildArmPayload(sessionId, titleRef.current, false),
            controller === null ? undefined : controller.signal,
          );
          if (mountedRef.current !== true || seq !== seqRef.current || result.aborted === true) return;
          if (result.ok === true) {
            const value = normalizeArmValue(result.value);
            if (value === null) {
              setError({ code: 'bad-response', message: 'Unexpected camera.arm response.', details: undefined });
              setPhase('error');
              return;
            }
            setData(value);
            setError(null);
            setPhase('ready');
            setNow(Date.now());
          } else {
            setData(null);
            setError(result.error);
            setPhase('error');
          }
        })();
        return () => {
          if (controller !== null) {
            try {
              controller.abort();
            } catch (abortError) {
              // Ignore double aborts.
            }
          }
          if (abortRef.current === controller) abortRef.current = null;
        };
      }, [api, sessionId, reloadKey]);

      // One `camera.status` read enriches the panel with Host warnings (e.g. a
      // port fallback). Failures are silent: `camera.arm` is the source of truth.
      React.useEffect(() => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let cancelled = false;
        void (async () => {
          const result = await safeCall(api, 'camera.status', {}, controller === null ? undefined : controller.signal);
          if (cancelled || mountedRef.current !== true || result.aborted === true) return;
          if (result.ok !== true) return;
          const server = result.value && result.value.server;
          const serverWarning = server && typeof server === 'object' ? asText(server.warning) : '';
          setWarning(serverWarning);
        })();
        return () => {
          cancelled = true;
          if (controller !== null) controller.abort();
        };
      }, [api]);

      // Poll `camera.recent` every 3s while the panel is open (DESIGN 3.9).
      React.useEffect(() => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let stopped = false;
        const poll = async () => {
          const result = await safeCall(
            api,
            'camera.recent',
            { limit: RECENT_LIMIT },
            controller === null ? undefined : controller.signal,
          );
          if (stopped || mountedRef.current !== true || result.aborted === true) return;
          if (result.ok === true && result.value && Array.isArray(result.value.uploads)) {
            setUploads(result.value.uploads);
          }
          // Poll failures stay invisible: the arm error line already explains
          // service problems, and stale counters are better than noise.
        };
        void poll();
        const timer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          void poll();
        }, RECENT_POLL_MS);
        return () => {
          stopped = true;
          if (controller !== null) controller.abort();
          window.clearInterval(timer);
        };
      }, [api, sessionId]);

      // One-second clock for the countdown.
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          if (mountedRef.current === true) setNow(Date.now());
        }, 1000);
        return () => window.clearInterval(timer);
      }, []);

      // Anchor the panel above the dock button and keep it inside the viewport.
      const place = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        const viewportWidth = window.innerWidth || 1024;
        const viewportHeight = window.innerHeight || 768;
        const width = Math.min(PANEL_WIDTH, Math.max(240, viewportWidth - 24));
        let left = 12;
        let bottom = 12;
        const node = anchorRef ? anchorRef.current : null;
        if (node && typeof node.getBoundingClientRect === 'function') {
          const rect = node.getBoundingClientRect();
          left = Math.min(Math.max(rect.left, 12), Math.max(12, viewportWidth - width - 12));
          bottom = Math.max(12, Math.min(viewportHeight - rect.top + 8, viewportHeight - 24));
        }
        setPos({ left, bottom, width });
      }, [anchorRef]);

      React.useEffect(() => {
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [place]);

      // Close on outside pointerdown / Escape (same pattern as the balance pill).
      React.useEffect(() => {
        const close = () => {
          if (typeof onCloseRef.current === 'function') onCloseRef.current();
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (!target || typeof target !== 'object') return;
          if (panelRef.current && panelRef.current.contains(target)) return;
          if (anchorRef && anchorRef.current && anchorRef.current.contains(target)) return;
          close();
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [anchorRef]);

      // Move focus into the dialog on open (Escape/outside click still work).
      React.useEffect(() => {
        const node = panelRef.current;
        if (!node || typeof node.focus !== 'function') return;
        try {
          node.focus({ preventScroll: true });
        } catch (focusError) {
          node.focus();
        }
      }, []);

      // Select the full link when the "Open on phone" block appears.
      React.useEffect(() => {
        if (showFullUrl !== true) return;
        const node = fullUrlInputRef.current;
        if (!node) return;
        try {
          node.focus({ preventScroll: true });
        } catch (focusError) {
          // Older browsers may not accept options.
        }
        if (typeof node.select === 'function') node.select();
      }, [showFullUrl]);

      const handleCopy = React.useCallback(async () => {
        const url = data && asText(data.url) !== '' ? data.url : '';
        if (url === '') return;
        let ok = false;
        try {
          ok = await copyText(url);
        } catch (copyError) {
          ok = false;
        }
        if (mountedRef.current !== true) return;
        setCopyState(ok === true ? 'copied' : 'failed');
        if (copyTimerRef.current !== 0) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current === true) {
            setCopyState('idle');
            copyTimerRef.current = 0;
          }
        }, COPY_FEEDBACK_MS);
      }, [data]);

      const handleRotate = React.useCallback(() => {
        if (busy === true) return;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (abortRef.current !== null) {
          try {
            abortRef.current.abort();
          } catch (abortError) {
            // Ignore.
          }
        }
        abortRef.current = controller;
        const seq = seqRef.current + 1;
        seqRef.current = seq;
        setBusy(true);
        setError(null);
        setCopyState('idle');
        setShowFullUrl(false);
        void (async () => {
          const result = await safeCall(
            api,
            'camera.arm',
            buildArmPayload(sessionId, titleRef.current, true),
            controller === null ? undefined : controller.signal,
          );
          if (mountedRef.current !== true || seq !== seqRef.current || result.aborted === true) return;
          setBusy(false);
          if (result.ok === true) {
            const value = normalizeArmValue(result.value);
            if (value === null) {
              setError({ code: 'bad-response', message: 'Unexpected camera.arm response.', details: undefined });
              return;
            }
            setData(value);
            setError(null);
            setPhase('ready');
            setNow(Date.now());
          } else {
            // Keep the still-working link; just add the failure line.
            setError(result.error);
          }
        })();
      }, [api, busy, sessionId]);

      const handleRetry = React.useCallback(() => {
        setReloadKey((key) => key + 1);
      }, []);

      const handleClose = React.useCallback(() => {
        if (typeof onCloseRef.current === 'function') onCloseRef.current();
      }, []);

      const handleToggleFullUrl = React.useCallback(() => {
        setShowFullUrl((value) => value !== true);
      }, []);

      // ---- derived values ------------------------------------------------
      const titleCaption = (data && asText(data.title) !== '' ? data.title : '') || knownTitle || tr('currentChat');
      const url = data && asText(data.url) !== '' ? data.url : '';
      const expiresAt = data && Number.isFinite(data.expiresAt) ? data.expiresAt : 0;
      const remainingMs = expiresAt > 0 ? expiresAt - now : NaN;
      const expired = data !== null && Number.isFinite(remainingMs) && remainingMs <= 0;
      const expiringSoon =
        data !== null && Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= EXPIRING_SOON_MS;
      const ttlText =
        data === null || Number.isFinite(remainingMs) === false
          ? '—'
          : expired === true
            ? tr('expiresExpired')
            : formatRemaining(remainingMs);
      const received = countSessionUploads(uploads, sessionId);
      const receivedUnit = tr('metaReceivedUnit');
      const qr = data && data.qr ? data.qr : null;

      // ---- render helpers (plain functions, never React components) -------
      const panelButton = (label, onClick, options) => {
        const opts = options || {};
        const className = opts.primary === true ? 'dshCam_btn dshCam_btnPrimary' : 'dshCam_btn';
        return h(
          'button',
          {
            type: 'button',
            className,
            onClick,
            disabled: opts.disabled === true,
            title: opts.title || label,
          },
          opts.icon ? opts.icon() : null,
          label,
        );
      };

      const renderHeader = () =>
        h(
          'div',
          { className: 'dshCam_header' },
          h(
            'div',
            { className: 'dshCam_heading' },
            h('span', { className: 'dshCam_title' }, cameraIcon(), tr('panelTitle')),
            h('span', { className: 'dshCam_subtitle' }, tr('panelSubtitle')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshCam_close',
              'aria-label': tr('close'),
              title: tr('close'),
              onClick: handleClose,
            },
            closeIcon(),
          ),
        );

      const renderSteps = () =>
        h(
          'div',
          { className: 'dshCam_stepsBlock' },
          h('div', { className: 'dshCam_stepsTitle' }, tr('stepsTitle')),
          h(
            'ol',
            { className: 'dshCam_steps' },
            h(
              'li',
              { className: 'dshCam_step' },
              h('span', { className: 'dshCam_stepNo', 'aria-hidden': true }, '1'),
              h('span', null, tr('step1')),
            ),
            h(
              'li',
              { className: 'dshCam_step' },
              h('span', { className: 'dshCam_stepNo', 'aria-hidden': true }, '2'),
              h('span', null, tr('step2')),
            ),
            h(
              'li',
              { className: 'dshCam_step' },
              h('span', { className: 'dshCam_stepNo', 'aria-hidden': true }, '3'),
              h('span', null, tr('step3')),
            ),
          ),
        );

      const renderQrFrame = () => {
        const dim = expired === true || busy === true;
        return h(
          'div',
          { className: 'dshCam_qrFrame', 'data-dim': dim === true ? 'true' : 'false' },
          qr !== null
            ? h(
                'svg',
                {
                  className: 'dshCam_qr',
                  viewBox: `0 0 ${qr.size} ${qr.size}`,
                  width: QR_EDGE,
                  height: QR_EDGE,
                  role: 'img',
                  'aria-label': tr('qrAria'),
                  'data-dsh-camera-qr': '',
                  shapeRendering: 'crispEdges',
                  focusable: 'false',
                },
                h('path', { d: qr.path, fill: 'currentColor', shapeRendering: 'crispEdges' }),
              )
            : h('div', { className: 'dshCam_qrFallback' }, tr('qrUnavailable')),
          busy === true
            ? h(
                'div',
                { className: 'dshCam_qrOverlay' },
                h('div', { className: 'dshCam_spinner', 'aria-hidden': true }),
                h('span', { className: 'dshCam_qrOverlayText' }, tr('rotating')),
              )
            : null,
          expired === true && busy !== true
            ? h(
                'div',
                { className: 'dshCam_qrOverlay' },
                h('span', { className: 'dshCam_qrOverlayText dshCam_qrOverlayExpired' }, tr('expiresExpired')),
              )
            : null,
        );
      };

      const renderMeta = () =>
        h(
          'dl',
          { className: 'dshCam_meta' },
          h('dt', null, tr('metaChat')),
          h('dd', { className: 'dshCam_metaChat', title: titleCaption }, titleCaption),
          h('dt', null, tr('metaExpires')),
          h(
            'dd',
            {
              className: expired === true ? 'dshCam_expired' : expiringSoon === true ? 'dshCam_expiring' : '',
              'data-expired': expired === true ? 'true' : 'false',
            },
            ttlText,
          ),
          h('dt', null, tr('metaReceived')),
          h(
            'dd',
            null,
            h('span', { className: 'dshCam_countValue', 'data-dsh-camera-count': String(received) }, String(received)),
            receivedUnit !== '' ? h('span', { className: 'dshCam_countUnit' }, ` ${receivedUnit}`) : null,
          ),
        );

      const renderUrl = () =>
        h(
          'div',
          { className: 'dshCam_urlRow' },
          h('code', { className: 'dshCam_urlText', title: url, 'data-dsh-camera-url': url }, url),
          h(
            'button',
            {
              type: 'button',
              className: 'dshCam_btn dshCam_btnPrimary dshCam_copyBtn',
              onClick: handleCopy,
              title: tr('copy'),
              disabled: url === '',
            },
            copyIcon(),
            copyState === 'copied' ? tr('copied') : copyState === 'failed' ? tr('copyFailed') : tr('copy'),
          ),
        );

      const renderFullUrl = () =>
        h(
          'div',
          { className: 'dshCam_fullUrlBox' },
          h('span', { className: 'dshCam_fullUrlHint' }, tr('fullUrlHint')),
          h('input', {
            ref: fullUrlInputRef,
            className: 'dshCam_fullUrl',
            type: 'text',
            readOnly: true,
            value: url,
            'aria-label': tr('fullUrlAria'),
            onFocus: (event) => event.currentTarget.select(),
            onClick: (event) => event.currentTarget.select(),
          }),
        );

      const renderErrorLine = () => {
        if (!error) return null;
        const copy = errorCopy(tr, error);
        const message = asText(error.message);
        return h(
          'div',
          {
            className: 'dshCam_error',
            role: 'alert',
            'data-dsh-camera-error': asText(error.code) || 'error',
          },
          errorIcon(),
          h(
            'div',
            { className: 'dshCam_errorBody' },
            h('span', { className: 'dshCam_errorTitle' }, copy.title),
            message !== '' && message !== copy.title ? h('span', { className: 'dshCam_errorMsg' }, message) : null,
            h('span', { className: 'dshCam_errorHint' }, copy.hint),
          ),
        );
      };

      const renderWarning = () => {
        if (asText(warning) === '') return null;
        return h(
          'div',
          { className: 'dshCam_notice', role: 'status' },
          warningIcon(),
          h('span', { className: 'dshCam_noticeText' }, tr('warningNotice', { message: warning })),
        );
      };

      const renderLoadingBody = () =>
        h(
          'div',
          { className: 'dshCam_body dshCam_bodyLoading' },
          h(
            'div',
            { className: 'dshCam_qrFrame dshCam_qrFrameLoading' },
            h('div', { className: 'dshCam_spinner', 'aria-hidden': true }),
            h('span', { className: 'dshCam_loadingText' }, tr('loading')),
          ),
          h('span', { className: 'dshCam_loadingHint' }, tr('loadingHint')),
          renderSteps(),
        );

      const renderErrorBody = () =>
        h(
          'div',
          { className: 'dshCam_body dshCam_bodyError' },
          renderErrorLine(),
          h(
            'div',
            { className: 'dshCam_actions' },
            panelButton(tr('retry'), handleRetry, { primary: true }),
            panelButton(tr('close'), handleClose),
          ),
        );

      const renderReadyBody = () =>
        h(
          'div',
          { className: 'dshCam_body' },
          renderQrFrame(),
          renderSteps(),
          renderMeta(),
          h('div', { className: 'dshCam_urlBox' }, renderUrl(), showFullUrl === true ? renderFullUrl() : null),
          copyState === 'failed'
            ? h('div', { className: 'dshCam_copyHint', role: 'status' }, tr('copyHint'))
            : null,
          renderErrorLine(),
          renderWarning(),
          blank === true ? h('div', { className: 'dshCam_note' }, tr('blankHint')) : null,
          h(
            'div',
            { className: 'dshCam_actions' },
            panelButton(tr('openInPhone'), handleToggleFullUrl, { icon: phoneIcon }),
            panelButton(busy === true ? tr('rotating') : tr('rotate'), handleRotate, {
              icon: rotateIcon,
              disabled: busy === true,
            }),
          ),
        );

      const panelStyle =
        pos === undefined
          ? { visibility: 'hidden', left: 0, bottom: 0, width: PANEL_WIDTH }
          : { left: pos.left, bottom: pos.bottom, width: pos.width };

      return h(
        'div',
        {
          ref: panelRef,
          className: 'dshCam_panel',
          role: 'dialog',
          'aria-modal': 'false',
          'aria-label': tr('panelTitle'),
          'data-dsh-camera-panel': phase,
          tabIndex: -1,
          style: panelStyle,
        },
        renderHeader(),
        phase === 'loading' ? renderLoadingBody() : phase === 'error' ? renderErrorBody() : renderReadyBody(),
      );
    }

    // ------------------------------------------------------------------
    // Dock entry
    // ------------------------------------------------------------------

    /**
     * Composer-dock button. Owns open/closed state, the anchor ref, and the
     * session title derivation; the heavy network state lives in CameraPanel.
     */
    const CameraDock = React.memo(function CameraDock(props) {
      const { t, api, sessionId, useSessions, useSession } = props;
      const tr = (key, params) => (typeof t === 'function' ? t(key, params) : key);
      const [open, setOpen] = React.useState(false);
      const anchorRef = React.useRef(null);
      const sessionRef = React.useRef(sessionId);

      // Session scope always supplies these hooks, but stay defensive so a
      // composition drift can never throw during render.
      const useSessionsSafe = typeof useSessions === 'function' ? useSessions : noopHook;
      const useSessionSafe = typeof useSession === 'function' ? useSession : noopHook;
      const listTitle = useSessionsSafe((state) => selectSessionTitle(state, sessionId));
      const blank = useSessionSafe((snapshot) =>
        snapshot && typeof snapshot === 'object' ? snapshot.blank === true : undefined,
      );

      const propTitle = typeof props.title === 'string' ? props.title.trim() : '';
      const knownTitle = propTitle !== '' ? propTitle : typeof listTitle === 'string' ? listTitle.trim() : '';

      // Switching conversations while open closes the panel (the new session
      // gets its own token when reopened).
      React.useEffect(() => {
        if (sessionRef.current !== sessionId) {
          sessionRef.current = sessionId;
          setOpen(false);
        }
      }, [sessionId]);

      const handleToggle = React.useCallback(() => {
        setOpen((value) => value !== true);
      }, []);

      const handleClose = React.useCallback(() => {
        setOpen(false);
      }, []);

      if (typeof sessionId !== 'string' || sessionId === '') return null;

      return h(
        Fragment,
        null,
        h(
          'span',
          { className: 'dshCam_anchor' },
          h(
            'button',
            {
              ref: anchorRef,
              type: 'button',
              className: 'dshCam_dock',
              'data-dsh-camera-dock': 'camera-upload',
              'aria-haspopup': 'dialog',
              'aria-expanded': open === true,
              'aria-label': tr('dockAria'),
              title: tr('dockLabel'),
              onClick: handleToggle,
            },
            cameraIcon(),
            h('span', { className: 'dshCam_dockLabel' }, tr('dockLabel')),
          ),
        ),
        open === true && typeof document !== 'undefined'
          ? createPortal(
              h(CameraPanel, {
                api,
                sessionId,
                t,
                anchorRef,
                title: knownTitle,
                blank: blank === true,
                onClose: handleClose,
              }),
              document.body,
            )
          : null,
      );
    });

    // ------------------------------------------------------------------
    // Styles (theme tokens only; the QR tile stays white/black on purpose)
    // ------------------------------------------------------------------

    const STYLE_ID = '@local/dsh-camera/CameraPanel.css';

    const CSS = [
      '.dshCam_anchor{min-width:0;display:inline-flex;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.dshCam_dock{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}',
      '.dshCam_dock svg{flex:none;width:14px;height:14px}',
      '.dshCam_dock:hover,.dshCam_dock[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshCam_dock:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dshCam_dockLabel{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '@media (max-width: 639px){.dshCam_dockLabel{display:none}.dshCam_dock{padding:1px 6px}}',
      '.dshCam_panel{position:fixed;z-index:1100;box-sizing:border-box;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:14px 16px 14px;cursor:default;display:flex;flex-direction:column;gap:12px}',
      '.dshCam_panel:focus{outline:none}',
      '.dshCam_header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.dshCam_heading{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dshCam_title{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
      '.dshCam_title svg{flex:none;width:14px;height:14px}',
      '.dshCam_subtitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:break-word}',
      '.dshCam_close{box-sizing:border-box;flex:none;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);display:grid;place-items:center;cursor:pointer}',
      '.dshCam_close svg{width:14px;height:14px}',
      '.dshCam_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshCam_close:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dshCam_body{display:flex;flex-direction:column;gap:12px}',
      '.dshCam_qrFrame{position:relative;align-self:center;box-sizing:border-box;width:224px;height:224px;padding:12px;display:grid;place-items:center;border-radius:var(--dsw-radius-md);background:#fff;border:.5px solid var(--dsw-alias-border-l2)}',
      '.dshCam_qr{display:block;width:200px;height:200px;max-width:100%;color:#000}',
      '.dshCam_qrFrame[data-dim="true"] .dshCam_qr{opacity:.22}',
      '.dshCam_qrFallback{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-align:center;padding:0 8px}',
      '.dshCam_qrOverlay{position:absolute;inset:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border-radius:var(--dsw-radius-sm);background:rgba(255,255,255,.78);color:#1f2328;text-align:center}',
      '.dshCam_qrOverlayText{font-size:12px;line-height:17px;font-weight:500}',
      '.dshCam_qrOverlayExpired{color:#b42318}',
      '.dshCam_qrFrameLoading{background:0 0;border:.5px dashed var(--dsw-alias-border-l3);gap:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}',
      '.dshCam_loadingText{font-size:12px;line-height:17px}',
      '.dshCam_loadingHint{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-align:center;margin-top:-6px}',
      '.dshCam_spinner{width:18px;height:18px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);animation:dshCamSpin .9s linear infinite}',
      '@keyframes dshCamSpin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.dshCam_spinner{animation-duration:2.4s}}',
      '.dshCam_stepsBlock{display:flex;flex-direction:column;gap:6px}',
      '.dshCam_stepsTitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:500}',
      '.dshCam_steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}',
      '.dshCam_step{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dshCam_stepNo{flex:none;box-sizing:border-box;width:16px;height:16px;margin-top:1px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:500;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}',
      '.dshCam_meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;margin:0;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.dshCam_meta dt,.dshCam_meta dd{min-width:0;margin:0}',
      '.dshCam_meta dd{color:var(--dsw-alias-label-secondary);text-align:right;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshCam_metaChat{color:var(--dsw-alias-label-primary)!important}',
      '.dshCam_countValue{color:var(--dsw-alias-label-primary)}',
      '.dshCam_expiring{color:var(--dsw-alias-state-warn-primary)!important}',
      '.dshCam_expired{color:var(--dsw-alias-label-error)!important}',
      '.dshCam_urlBox{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dshCam_urlRow{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dshCam_urlText{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:5px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:all}',
      '.dshCam_copyBtn{flex:none}',
      '.dshCam_fullUrlBox{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dshCam_fullUrlHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dshCam_fullUrl{box-sizing:border-box;width:100%;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px}',
      '.dshCam_fullUrl:focus{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}',
      '.dshCam_copyHint{color:var(--dsw-alias-label-error);font-size:11px;line-height:16px}',
      '.dshCam_actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}',
      '.dshCam_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
      '.dshCam_btn svg{flex:none;width:13px;height:13px}',
      '.dshCam_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCam_btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dshCam_btn:disabled{opacity:.55;cursor:default;background:0 0}',
      '.dshCam_btnPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:500}',
      '.dshCam_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshCam_error{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;padding:8px 10px;border-radius:var(--dsw-radius-md);background:rgba(220,38,38,.09);color:var(--dsw-alias-label-error);font-size:12px;line-height:17px}',
      '.dshCam_error svg{flex:none;width:14px;height:14px;margin-top:1px}',
      '.dshCam_errorBody{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dshCam_errorTitle{font-weight:500}',
      '.dshCam_errorMsg{color:var(--dsw-alias-label-secondary);overflow-wrap:break-word}',
      '.dshCam_errorHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dshCam_notice{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;padding:8px 10px;border-radius:var(--dsw-radius-md);background:rgba(245,158,11,.1);color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px}',
      '.dshCam_notice svg{flex:none;width:13px;height:13px;margin-top:1px}',
      '.dshCam_noticeText{min-width:0;overflow-wrap:break-word}',
      '.dshCam_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;border-top:.5px dashed var(--dsw-alias-border-l2);padding-top:8px}',
      '.dshCam_bodyError{gap:10px}',
    ].join('\n');

    /** Add the dock/panel styles once per page; remove them when unloaded. */
    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {};
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-camera';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    // ------------------------------------------------------------------
    // Plugin entry
    // ------------------------------------------------------------------

    const inject = ['slots', 'locale', 'connection'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-camera: dictionaries');
      ctx.effect(() => installStyles(), 'dsh-camera: styles');
      const api = createCameraApi(ctx);
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'camera-upload',
            order: 3,
            locale: NS,
            inject: () => ({ api }),
          },
          CameraDock,
        ),
      );
    }

    return { inject, apply };
  },
});
