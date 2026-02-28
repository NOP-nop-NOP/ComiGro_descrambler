// ==UserScript==
// @name         Comic-Growl 漫画下载器
// @namespace    https://comic-growl.com/
// @version      1.3.0
// @description  自动解码并下载 comic-growl.com 的漫画章节，支持右开书拼页模式
// @author       manka
// @homepage     https://github.com/NOP-nop-NOP/ComiGro_descrambler
// @supportURL   https://github.com/NOP-nop-NOP/ComiGro_descrambler/issues
// @match        https://comic-growl.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      comic-growl.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ─── 状态 ────────────────────────────────────────────────────────────────
    const capturedApis = []; // { url, timestamp }
    let url1 = '';
    let url2 = '';
    let mode = 0; // 0: 不拼页, 1: 第一图在右侧, 2: 第一图在左侧

    // ─── 是否为章节页（用于控制 UI 显示）────────────────────────────────────
    const isEpisodePage = () => /\/episodes\//.test(window.location.pathname);

    // ─── 获取页面真实 window（绕过油猴沙箏隔离）──────────────────────────
    // 油猴脚本的 window 是沙箏内的，页面 JS 用的是原生 window
    // 必须 hook unsafeWindow 才能拦截页面发出的网络请求
    const pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // ─── 拦截 XHR ────────────────────────────────────────────────────────────────
    const OrigXHR = pageWin.XMLHttpRequest;
    class HookedXHR extends OrigXHR {
        open(method, url, ...args) {
            this._hookedUrl = url;
            super.open(method, url, ...args);
        }
        send(...args) {
            this.addEventListener('load', () => {
                if (this._hookedUrl && this._hookedUrl.includes('/api/book/contentsInfo')) {
                    onApiCaptured(this._hookedUrl);
                }
            });
            super.send(...args);
        }
    }
    pageWin.XMLHttpRequest = HookedXHR;

    // 拦截 fetch（兼容 string / URL / Request 三种入参）
    const origFetch = pageWin.fetch;
    pageWin.fetch = function (input, init) {
        let url = '';
        if (typeof input === 'string') url = input;
        else if (input instanceof pageWin.URL) url = input.href;
        else if (input && typeof input.url === 'string') url = input.url;
        if (url.includes('/api/book/contentsInfo')) {
            onApiCaptured(url);
        }
        return origFetch.apply(this, arguments);
    };

    // 占位符：initUI 执行前 API 就可能被捕获，数据先存入 capturedApis
    // initUI 运行后会替换为真实实现，末尾 renderCapturedList() 补显所有已捕获项
    let renderCapturedList = () => { };
    let showToast = () => { };

    function getPageTo(url) {
        const m = url.match(/[?&]page-to=(\d+)/);
        return m ? parseInt(m[1]) : 0;
    }
    function getUrlPrefix(url) {
        // &page-to 及其后的内容视为变量部分，前面的作为"同一 API"的标识
        return url.replace(/([?&])page-to=\d+.*/, '$1');
    }

    function onApiCaptured(url) {
        const prefix = getUrlPrefix(url);
        const pageTo = getPageTo(url);
        const existingIdx = capturedApis.findIndex(a => getUrlPrefix(a.url) === prefix);
        if (existingIdx !== -1) {
            // 已有同前缀——只保留 page-to 更大的
            if (pageTo <= getPageTo(capturedApis[existingIdx].url)) return;
            capturedApis.splice(existingIdx, 1, { url, timestamp: Date.now() });
        } else {
            capturedApis.push({ url, timestamp: Date.now() });
        }
        renderCapturedList();
        showToast('✅ 已捕获 API 请求');
    }

    // ─── UI 仅在章节页初始化 ──────────────────────────────────────────────────
    // 钩子在全站生效（document-start），但 DOM/UI 只在章节页创建
    if (!isEpisodePage()) {
        // 非章节页：持续监听路由变化（SPA 跳转），跳转到章节页时再初始化 UI
        const observer = new MutationObserver(() => {
            if (isEpisodePage() && !document.getElementById('cgd-panel')) {
                observer.disconnect();
                initUI();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        // 同时监听 History API（pushState / replaceState）
        const origPush = history.pushState.bind(history);
        const origReplace = history.replaceState.bind(history);
        const checkRoute = () => {
            if (isEpisodePage() && !document.getElementById('cgd-panel')) initUI();
        };
        history.pushState = function (...a) { origPush(...a); checkRoute(); };
        history.replaceState = function (...a) { origReplace(...a); checkRoute(); };
        window.addEventListener('popstate', checkRoute);
        return; // 非章节页不继续执行下方 UI 代码
    }

    initUI();
    function initUI() {
        // 保护：document-start 时 body 可能还不存在
        if (!document.body) {
            window.addEventListener('DOMContentLoaded', initUI);
            return;
        }

        // ─── UI 注入 ──────────────────────────────────────────────────────────────
        const styles = `
        #cgd-panel, #cgd-panel * { box-sizing: border-box; }
        #cgd-panel {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 400px;
            background: rgba(18, 18, 28, 0.96);
            border: 1px solid rgba(120, 80, 255, 0.4);
            border-radius: 14px;
            box-shadow: 0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(120,80,255,0.1);
            font-family: 'Segoe UI', system-ui, sans-serif;
            font-size: 13px;
            color: #e0e0f0;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transition: all 0.3s ease;
            user-select: none;
        }
        #cgd-panel.cgd-collapsed #cgd-body { display: none; }
        #cgd-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: linear-gradient(135deg, rgba(100,60,230,0.5), rgba(60,30,180,0.3));
            cursor: move;
        }
        #cgd-header-title {
            font-weight: 700;
            font-size: 14px;
            letter-spacing: 0.5px;
            background: linear-gradient(90deg, #c4a0ff, #7ec8ff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        #cgd-toggle-btn {
            background: none;
            border: none;
            color: #a0a0c0;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            padding: 0 4px;
            transition: color 0.2s;
        }
        #cgd-toggle-btn:hover { color: #fff; }
        #cgd-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
        .cgd-section-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #7060a0;
            margin-bottom: 4px;
        }
        #cgd-captured-list {
            max-height: 140px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        #cgd-captured-list::-webkit-scrollbar { width: 4px; }
        #cgd-captured-list::-webkit-scrollbar-track { background: transparent; }
        #cgd-captured-list::-webkit-scrollbar-thumb { background: #4040a0; border-radius: 2px; }
        .cgd-api-item {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 8px;
            padding: 8px 10px;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .cgd-api-url {
            font-size: 11px;
            color: #8080c0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            cursor: default;
        }
        .cgd-api-url:hover { color: #c0c0ff; }
        .cgd-api-btns {
            display: flex;
            gap: 6px;
        }
        .cgd-api-btns button {
            flex: 1;
            padding: 4px 0;
            border: 1px solid rgba(120,80,255,0.4);
            background: rgba(80,40,200,0.2);
            color: #b0a0ff;
            border-radius: 5px;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .cgd-api-btns button:hover {
            background: rgba(100,60,255,0.5);
            color: #fff;
        }
        .cgd-api-btns button.cgd-assigned {
            background: rgba(80,200,120,0.25);
            border-color: rgba(80,200,120,0.5);
            color: #80ffb0;
        }
        .cgd-no-capture {
            color: #505070;
            font-size: 12px;
            text-align: center;
            padding: 10px 0;
        }
        .cgd-url-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .cgd-url-label {
            font-size: 12px;
            color: #9080c0;
            min-width: 42px;
            font-weight: 600;
        }
        .cgd-url-input {
            flex: 1;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(120,80,255,0.25);
            border-radius: 6px;
            padding: 6px 10px;
            color: #d0d0f0;
            font-size: 11px;
            outline: none;
            transition: border-color 0.2s;
        }
        .cgd-url-input:focus { border-color: rgba(120,80,255,0.7); }
        .cgd-url-input.cgd-filled { border-color: rgba(80,200,120,0.5); }
        .cgd-url-clear {
            background: none;
            border: none;
            color: #604060;
            cursor: pointer;
            font-size: 14px;
            padding: 0 2px;
            transition: color 0.2s;
        }
        .cgd-url-clear:hover { color: #ff8080; }
        #cgd-mode-group {
            display: flex;
            gap: 8px;
        }
        .cgd-mode-btn {
            flex: 1;
            padding: 7px 4px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 7px;
            color: #8080b0;
            font-size: 11px;
            cursor: pointer;
            text-align: center;
            transition: all 0.2s;
            line-height: 1.3;
        }
        .cgd-mode-btn:hover { border-color: rgba(120,80,255,0.4); color: #c0b0ff; }
        .cgd-mode-btn.cgd-active {
            background: rgba(100,60,230,0.35);
            border-color: rgba(120,80,255,0.7);
            color: #d0c0ff;
            font-weight: 600;
        }
        #cgd-download-btn {
            width: 100%;
            padding: 10px;
            background: linear-gradient(135deg, #6030e0, #4020b0);
            border: none;
            border-radius: 8px;
            color: #fff;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            letter-spacing: 0.5px;
            transition: all 0.2s;
            position: relative;
            overflow: hidden;
        }
        #cgd-download-btn:hover:not(:disabled) {
            background: linear-gradient(135deg, #7040f0, #5030c0);
            box-shadow: 0 4px 20px rgba(100,60,230,0.5);
        }
        #cgd-download-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #cgd-progress {
            display: none;
            flex-direction: column;
            gap: 6px;
        }
        #cgd-progress.visible { display: flex; }
        #cgd-progress-bar-track {
            height: 6px;
            background: rgba(255,255,255,0.08);
            border-radius: 3px;
            overflow: hidden;
        }
        #cgd-progress-bar {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #6030e0, #40b0ff);
            border-radius: 3px;
            transition: width 0.3s ease;
        }
        #cgd-progress-text {
            font-size: 11px;
            color: #8080b0;
            text-align: center;
        }
        #cgd-toast {
            position: fixed;
            bottom: 80px;
            right: 24px;
            background: rgba(40, 30, 70, 0.95);
            border: 1px solid rgba(120,80,255,0.4);
            border-radius: 8px;
            padding: 8px 16px;
            color: #d0c0ff;
            font-size: 12px;
            z-index: 2147483647;
            opacity: 0;
            transform: translateY(10px);
            transition: all 0.3s ease;
            pointer-events: none;
            font-family: 'Segoe UI', system-ui, sans-serif;
        }
        #cgd-toast.show { opacity: 1; transform: translateY(0); }
        .cgd-section-label-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 4px;
        }
        .cgd-section-label-row .cgd-section-label { margin-bottom: 0; }
        #cgd-switch-vertical {
            padding: 3px 10px;
            background: rgba(255,160,30,0.15);
            border: 1px solid rgba(255,160,30,0.45);
            border-radius: 5px;
            color: #ffcc66;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
        }
        #cgd-switch-vertical:hover {
            background: rgba(255,160,30,0.35);
            color: #fff;
        }
        #cgd-switch-vertical.cgd-vertical-ok {
            background: rgba(60,200,100,0.15);
            border-color: rgba(60,200,100,0.4);
            color: #80ffaa;
            cursor: default;
        }
        #cgd-mode-hint {
            font-size: 11px;
            color: #ff9944;
            margin-bottom: 4px;
            display: none;
        }
        #cgd-mode-hint.visible { display: block; }
    `;

        const styleEl = document.createElement('style');
        styleEl.textContent = styles;
        document.head.appendChild(styleEl);

        const panel = document.createElement('div');
        panel.id = 'cgd-panel';
        panel.innerHTML = `
        <div id="cgd-header">
            <span id="cgd-header-title">⬇ Comic-Growl 下载器</span>
            <button id="cgd-toggle-btn" title="折叠/展开">−</button>
        </div>
        <div id="cgd-body">
            <div>
                <div class="cgd-section-label-row">
                    <span class="cgd-section-label">🔍 已捕获 API 请求</span>
                    <button id="cgd-switch-vertical" title="点击切换为竖排模式，滚动即可触发 API 捕获">📜 切换为竖排</button>
                </div>
                <div id="cgd-mode-hint"></div>
                <div id="cgd-captured-list"><div class="cgd-no-capture">在此页面浏览漫画后自动捕获…</div></div>
            </div>
            <div>
                <div class="cgd-section-label">📌 已锁定 URL</div>
                <div class="cgd-url-row">
                    <span class="cgd-url-label">URL 1</span>
                    <input class="cgd-url-input" id="cgd-url1" placeholder="必填：章节一 API 地址" />
                    <button class="cgd-url-clear" id="cgd-clear1" title="清除">✕</button>
                </div>
                <div class="cgd-url-row" style="margin-top:6px">
                    <span class="cgd-url-label">URL 2</span>
                    <input class="cgd-url-input" id="cgd-url2" placeholder="可选：章节二 API 地址（合并）" />
                    <button class="cgd-url-clear" id="cgd-clear2" title="清除">✕</button>
                </div>
            </div>
            <div>
                <div class="cgd-section-label">📖 拼页模式</div>
                <div id="cgd-mode-group">
                    <button class="cgd-mode-btn cgd-active" data-mode="0">不拼页<br><small>独立图片</small></button>
                    <button class="cgd-mode-btn" data-mode="1">右开·封面<br><small>封面独右+双页</small></button>
                    <button class="cgd-mode-btn" data-mode="2">右开·普通<br><small>封面独左+双页</small></button>
                </div>
            </div>
            <div id="cgd-progress">
                <div id="cgd-progress-bar-track"><div id="cgd-progress-bar"></div></div>
                <div id="cgd-progress-text">准备中…</div>
            </div>
            <button id="cgd-download-btn">⬇ 开始下载</button>
        </div>
    `;
        document.body.appendChild(panel);

        const toast = document.createElement('div');
        toast.id = 'cgd-toast';
        document.body.appendChild(toast);

        // ─── 拖拽 ─────────────────────────────────────────────────────────────────
        let dragging = false, dragStartX, dragStartY, panelStartRight, panelStartBottom;
        const header = document.getElementById('cgd-header');
        header.addEventListener('mousedown', e => {
            if (e.target.id === 'cgd-toggle-btn') return;
            dragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = panel.getBoundingClientRect();
            panelStartRight = window.innerWidth - rect.right;
            panelStartBottom = window.innerHeight - rect.bottom;
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            panel.style.right = Math.max(0, panelStartRight - dx) + 'px';
            panel.style.bottom = Math.max(0, panelStartBottom - dy) + 'px';
            panel.style.left = 'auto';
            panel.style.top = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        // ─── 折叠 ────────────────────────────────────────────────────────────────
        const toggleBtn = document.getElementById('cgd-toggle-btn');
        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('cgd-collapsed');
            toggleBtn.textContent = panel.classList.contains('cgd-collapsed') ? '+' : '−';
        });

        // ─── URL 输入框 ──────────────────────────────────────────────────────────
        const url1Input = document.getElementById('cgd-url1');
        const url2Input = document.getElementById('cgd-url2');
        url1Input.addEventListener('input', () => {
            url1 = url1Input.value.trim();
            url1Input.classList.toggle('cgd-filled', !!url1);
        });
        url2Input.addEventListener('input', () => {
            url2 = url2Input.value.trim();
            url2Input.classList.toggle('cgd-filled', !!url2);
        });
        document.getElementById('cgd-clear1').addEventListener('click', () => {
            url1Input.value = ''; url1 = ''; url1Input.classList.remove('cgd-filled');
            renderCapturedList();
        });
        document.getElementById('cgd-clear2').addEventListener('click', () => {
            url2Input.value = ''; url2 = ''; url2Input.classList.remove('cgd-filled');
            renderCapturedList();
        });

        // ─── 竖横排检测与切换 ────────────────────────────────────────────────────
        const switchBtn = document.getElementById('cgd-switch-vertical');
        const modeHint = document.getElementById('cgd-mode-hint');

        function isVerticalMode() {
            // 竖排模式下页面有 data-scroll-direction="vertical" 或viewer有竖排class
            // 也可检查 changeVHButton 的状态文字/aria
            const viewerEl = document.querySelector('[data-scroll-direction]');
            if (viewerEl) return viewerEl.dataset.scrollDirection === 'vertical';
            // fallback：横排模式下通常有横向overflow容器
            const hEl = document.querySelector('.-cv-horizontal, [class*="horizontal"]');
            return !hEl;
        }

        function clickVHButton() {
            const btn = document.getElementById('changeVHButton')
                || document.querySelector('.-cv-f-btn[data-nodal]')
                || document.querySelector('[data-i18n="1"]')?.closest('button, [role="button"], a');
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        }

        function updateVerticalStatus() {
            // 稍微等一下让DOM更新
            setTimeout(() => {
                const vh = isVerticalMode();
                if (vh) {
                    switchBtn.textContent = '✅ 已是竖排';
                    switchBtn.classList.add('cgd-vertical-ok');
                    modeHint.classList.remove('visible');
                } else {
                    switchBtn.textContent = '📜 切换为竖排';
                    switchBtn.classList.remove('cgd-vertical-ok');
                    modeHint.textContent = '⚠️ 横排模式下 API 不会触发，请先切换为竖排再滚动';
                    modeHint.classList.add('visible');
                }
            }, 300);
        }

        switchBtn.addEventListener('click', () => {
            if (switchBtn.classList.contains('cgd-vertical-ok')) return;
            const ok = clickVHButton();
            if (ok) {
                showToast('✅ 已切换为竖排，向下滚动即可捕获 API');
                updateVerticalStatus();
            } else {
                showToast('⚠️ 未找到切换按钮，请手动点击页面上的「縦横切替え」', 4000);
            }
        });

        // 初始化时检测模式（等页面稳定后）
        setTimeout(updateVerticalStatus, 1500);

        // ─── 模式选择 ───────────────────────────────────────────────────────────
        document.getElementById('cgd-mode-group').addEventListener('click', e => {
            const btn = e.target.closest('.cgd-mode-btn');
            if (!btn) return;
            document.querySelectorAll('.cgd-mode-btn').forEach(b => b.classList.remove('cgd-active'));
            btn.classList.add('cgd-active');
            mode = parseInt(btn.dataset.mode);
        });

        // ─── 捕获列表渲染（赋值给外层变量，使 onApiCaptured 可跨时序调用）────────
        renderCapturedList = function () {
            const list = document.getElementById('cgd-captured-list');
            if (!list) return; // 防止 DOM 尚未就绪
            if (capturedApis.length === 0) {
                list.innerHTML = '<div class="cgd-no-capture">在此页面浏览漫画后自动捕获…</div>';
                return;
            }
            list.innerHTML = '';
            capturedApis.forEach((api, index) => {
                const shortUrl = api.url.replace('https://comic-growl.com', '');
                const isUrl1 = url1 === api.url;
                const isUrl2 = url2 === api.url;

                const item = document.createElement('div');
                item.className = 'cgd-api-item';
                item.innerHTML = `
                <div class="cgd-api-url" title="${api.url}">${shortUrl}</div>
                <div class="cgd-api-btns">
                    <button class="cgd-btn-set1 ${isUrl1 ? 'cgd-assigned' : ''}" data-index="${index}">
                        ${isUrl1 ? '✓ URL 1' : '→ URL 1'}
                    </button>
                    <button class="cgd-btn-set2 ${isUrl2 ? 'cgd-assigned' : ''}" data-index="${index}">
                        ${isUrl2 ? '✓ URL 2' : '→ URL 2'}
                    </button>
                    <button class="cgd-btn-copy" data-index="${index}">复制</button>
                </div>
            `;
                item.querySelector('.cgd-api-url').addEventListener('click', () => {
                    navigator.clipboard.writeText(api.url).catch(() => { });
                    showToast('链接已复制到剪贴板');
                });
                item.querySelector('.cgd-btn-set1').addEventListener('click', () => {
                    url1 = api.url; url1Input.value = api.url; url1Input.classList.add('cgd-filled');
                    renderCapturedList();
                    showToast('已设为 URL 1');
                });
                item.querySelector('.cgd-btn-set2').addEventListener('click', () => {
                    url2 = api.url; url2Input.value = api.url; url2Input.classList.add('cgd-filled');
                    renderCapturedList();
                    showToast('已设为 URL 2');
                });
                item.querySelector('.cgd-btn-copy').addEventListener('click', () => {
                    navigator.clipboard.writeText(api.url).catch(() => { });
                    showToast('已复制');
                });
                list.appendChild(item);
            });
        };

        // ─── Toast（赋值给外层变量，使 onApiCaptured 也能访问）──────────────────
        let toastTimer = null;
        showToast = function (msg, duration = 2500) {
            toast.textContent = msg;
            toast.classList.add('show');
            if (toastTimer) clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
        };

        // ─── 进度条 ─────────────────────────────────────────────────────────────
        function setProgress(pct, text) {
            const progressEl = document.getElementById('cgd-progress');
            const bar = document.getElementById('cgd-progress-bar');
            const label = document.getElementById('cgd-progress-text');
            progressEl.classList.add('visible');
            bar.style.width = pct + '%';
            label.textContent = text;
        }
        function hideProgress() {
            document.getElementById('cgd-progress').classList.remove('visible');
            document.getElementById('cgd-progress-bar').style.width = '0%';
        }

        // ─── GM_xmlhttpRequest Promise 封装 ─────────────────────────────────────
        function gmFetch(url, responseType = 'text') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType,
                    headers: {
                        'Referer': window.location.href,
                        'User-Agent': navigator.userAgent,
                    },
                    onload: r => {
                        if (r.status >= 200 && r.status < 300) {
                            resolve(r.response);
                        } else {
                            reject(new Error(`HTTP ${r.status}: ${url}`));
                        }
                    },
                    onerror: e => reject(new Error(`Network error: ${url}`)),
                });
            });
        }

        // ─── 获取图片信息列表 ────────────────────────────────────────────────────
        async function fetchImageList(apiUrl) {
            const text = await gmFetch(apiUrl, 'text');
            const data = JSON.parse(text);
            if (!data.result) throw new Error('API 返回格式异常，缺少 result 字段');
            return data.result;
        }

        // ─── Canvas descramble（对应 Python 的 descramble_image）────────────────
        function descrambleImage(img, scrambleStr, width, height) {
            const n = 4;
            const mainWidth = Math.floor(width / n) * n;
            const blockW = Math.floor(mainWidth / n);
            const blockH = Math.floor(height / n);

            const scramble = scrambleStr
                .replace(/\s/g, '').replace(/^\[|\]$/g, '')
                .split(',').map(Number);

            // 直接以 <img> 作为源，省去中间 srcCanvas 的内存与绘制开销
            const dstCanvas = document.createElement('canvas');
            dstCanvas.width = width;
            dstCanvas.height = height;
            const dstCtx = dstCanvas.getContext('2d');

            for (let pos = 0; pos < n * n; pos++) {
                const blockNum = scramble[pos];
                const posRow = pos % n;
                const posCol = Math.floor(pos / n);
                const srcRow = blockNum % n;
                const srcCol = Math.floor(blockNum / n);

                dstCtx.drawImage(
                    img,                                                 // 直接用 <img>
                    srcCol * blockW, srcRow * blockH, blockW, blockH,   // src rect
                    posCol * blockW, posRow * blockH, blockW, blockH     // dst rect
                );
            }

            // 复制最右侧剩余条
            if (width > mainWidth) {
                dstCtx.drawImage(
                    img,
                    mainWidth, 0, width - mainWidth, height,
                    mainWidth, 0, width - mainWidth, height
                );
            }

            return dstCanvas;
        }

        // ─── 下载并解码单张图片 ───────────────────────────────────────────────────
        function loadImageFromBlob(blob) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
                img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
                img.src = url;
            });
        }

        async function downloadAndDecode(result) {
            const { imageUrl, scramble, width, height } = result;
            const blob = await gmFetch(imageUrl, 'blob');
            const img = await loadImageFromBlob(blob);
            const canvas = descrambleImage(img, scramble, width, height);
            return canvas;
        }

        // ─── 拼页（对应 Python 的 combine_pages_right_to_left）──────────────────
        function combineCanvas(leftCanvas, rightCanvas, stdW, stdH) {
            const spread = document.createElement('canvas');
            spread.width = stdW * 2;
            spread.height = stdH;
            const ctx = spread.getContext('2d');
            if (leftCanvas) ctx.drawImage(leftCanvas, 0, 0, stdW, stdH);
            if (rightCanvas) ctx.drawImage(rightCanvas, stdW, 0, stdW, stdH);
            return spread;
        }

        function createBlankCanvas(width, height) {
            const c = document.createElement('canvas');
            c.width = width; c.height = height;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            return c;
        }

        function combinePagesRightToLeft(canvases, mode) {
            if (mode === 0 || canvases.length === 0) return canvases;

            const stdW = canvases[0].width;
            const stdH = canvases[0].height;
            const combined = [];
            let remaining;

            if (mode === 1) {
                // 第一图在右，第二图在左
                if (canvases.length >= 2) {
                    combined.push(combineCanvas(canvases[1], canvases[0], stdW, stdH));
                    remaining = canvases.slice(2);
                } else {
                    combined.push(combineCanvas(createBlankCanvas(stdW, stdH), canvases[0], stdW, stdH));
                    remaining = [];
                }
            } else {
                // mode === 2: 第一图在左，右边空白
                combined.push(combineCanvas(canvases[0], createBlankCanvas(stdW, stdH), stdW, stdH));
                remaining = canvases.slice(1);
            }

            // 两两配对，右开顺序：右页=前一张，左页=后一张
            for (let i = 0; i < remaining.length; i += 2) {
                const left = remaining[i + 1] || createBlankCanvas(stdW, stdH);
                const right = remaining[i];
                combined.push(combineCanvas(left, right, stdW, stdH));
            }

            return combined;
        }

        // ─── Canvas → Blob (JPG 最高质量) ────────────────────────────────────
        function canvasToBlob(canvas) {
            return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 1.0));
        }

        // ─── 从页面标题提取文件夹名 ────────────────────────────────────────────
        function getTitleName() {
            const raw = document.title || '';
            // 去掉网站名后缀（如「 | コミックグロウル」）
            const clean = raw.split('|')[0].trim();
            // 清除 Windows/Unix 路径非法字符
            return (clean.replace(/[\\/:*?"<>|]/g, '_').trim()) || 'episode';
        }

        // ─── GM_download Blob 封装 ─────────────────────────────────────────────
        function gmDownloadBlob(blob, fileName) {
            return new Promise((resolve, reject) => {
                const blobUrl = URL.createObjectURL(blob);
                GM_download({
                    url: blobUrl,
                    name: fileName,
                    onload: () => { URL.revokeObjectURL(blobUrl); resolve(); },
                    onerror: e => { URL.revokeObjectURL(blobUrl); reject(new Error('GM_download 失败: ' + JSON.stringify(e))); },
                });
            });
        }

        // ─── 主下载流程 ──────────────────────────────────────────────────────────────
        document.getElementById('cgd-download-btn').addEventListener('click', async () => {
            const u1 = url1Input.value.trim();
            if (!u1) { showToast('⚠️ 请先填写 URL 1', 3000); return; }

            const btn = document.getElementById('cgd-download-btn');
            btn.disabled = true;
            btn.textContent = '处理中…';

            try {
                setProgress(2, '获取图片列表…');
                let imageList = await fetchImageList(u1);

                const u2 = url2Input.value.trim();
                if (u2) {
                    setProgress(5, '获取第二段图片列表…');
                    const list2 = await fetchImageList(u2);
                    imageList = imageList.concat(list2);
                }

                const total = imageList.length;
                const folderName = getTitleName();

                if (mode === 0) {
                    // ── 不拼页：解码一张立即下载，内存占用最小 ──
                    for (let i = 0; i < total; i++) {
                        setProgress(
                            Math.round((i / total) * 95) + 2,
                            `下载并解码 ${i + 1} / ${total}…`
                        );
                        const canvas = await downloadAndDecode(imageList[i]);
                        const blob = await canvasToBlob(canvas);
                        canvas.width = 0; canvas.height = 0; // 释放 GPU
                        const name = `${folderName}/page_${String(i + 1).padStart(3, '0')}.jpg`;
                        await gmDownloadBlob(blob, name);
                    }
                } else {
                    // ── 拼页模式：先全量解码，再拼页并逐张下载 ──
                    const canvases = [];
                    for (let i = 0; i < total; i++) {
                        setProgress(
                            5 + Math.floor((i / total) * 60),
                            `下载并解码 ${i + 1} / ${total}…`
                        );
                        canvases.push(await downloadAndDecode(imageList[i]));
                    }

                    setProgress(66, '合并跨页…');
                    const pages = combinePagesRightToLeft(canvases, mode);
                    canvases.forEach(c => { c.width = 0; c.height = 0; });
                    canvases.length = 0;

                    for (let i = 0; i < pages.length; i++) {
                        setProgress(
                            68 + Math.round((i / pages.length) * 29),
                            `下载跨页 ${i + 1} / ${pages.length}…`
                        );
                        const blob = await canvasToBlob(pages[i]);
                        pages[i].width = 0; pages[i].height = 0;
                        const name = `${folderName}/spread_${String(i + 1).padStart(3, '0')}.jpg`;
                        await gmDownloadBlob(blob, name);
                    }
                }

                const count = mode === 0 ? total : Math.ceil(total / 2);
                setProgress(100, `✅ 完成！${count} 张已保入「${folderName}」文件夹`);
                showToast(`✅ 完成！保入下载文件夹内「${folderName}」`, 6000);
            } catch (err) {
                console.error('[Comic-Growl Downloader]', err);
                showToast('❌ 出错: ' + err.message, 5000);
                setProgress(0, '❌ 发生错误，请查看控制台');
            } finally {
                btn.disabled = false;
                btn.textContent = '⬇ 开始下载';
            }
        });


        renderCapturedList();

    } // end initUI

})();
