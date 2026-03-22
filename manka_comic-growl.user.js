// ==UserScript==
// @name         Comic-Growl 漫画下载器
// @namespace    https://comic-growl.com/
// @version      2.0.0
// @description  自动解码并下载 comic-growl.com 的漫画章节。支持队列下载、滑动窗口拼页、断点续传与网络重试。
// @author       manka & Antigravity
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

    // ─── 状态管理 ──────────────────────────────────────────────────────────────
    const state = {
        capturedApis: [], // { url, title, timestamp }
        downloadQueue: [], // { url, title }
        mode: 0, // 0: 不拼页, 1: 右开·封面 (封面独右+双页), 2: 右开·普通 (封面独左+双页)
        isDownloading: false,
        stopRequested: false
    };

    const STORAGE_KEY_PREFIX = 'cgd_resume_';

    // ─── 工具函数 ──────────────────────────────────────────────────────────────
    const isEpisodePage = () => /\/episodes\//.test(window.location.pathname);
    const getPageWin = () => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    // 从 API URL 获取标识符：保留除 page-to 之外的所有参数，用于区分不同章节
    function getUrlKey(url) {
        return url.replace(/([?&])page-to=\d+.*/, '$1');
    }

    // 尝试提取标题：从 DOM 或网页标题中获取，去掉 "| コミックグロウル" 后缀，并保留章节后缀（如 ①）。
    // 由于是 SPA，拦截请求时 DOM/title 可能还没渲染，加入短时轮询。
    async function fetchTitle(url) {
        for (let i = 0; i < 5; i++) { // 最多等 2.5 秒
            // 策略 1: 尝试从页面标题容器获取 (最可靠)
            const titleEl = document.querySelector('h1.ep-h-main-h');
            if (titleEl && titleEl.textContent) {
                const text = titleEl.textContent.trim();
                if (text && text !== '作品名') return text; 
            }

            // 策略 2: 尝试从 document.title 获取
            if (document.title && document.title.includes('| コミックグロウル')) {
                const title = document.title.split('|')[0].trim();
                if (title) return title;
            }
            
            await sleep(500); // 等待 SPA 渲染
        }

        // Fallback: 从 URL 提取 Episode ID
        const match = url.match(/\/episodes\/([a-zA-Z0-9]+)/);
        return match ? `Episode ${match[1]}` : 'Unknown Chapter';
    }

    // ─── 网络拦截 ──────────────────────────────────────────────────────────────
    function setupInterception() {
        const pageWin = getPageWin();
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
    }

    async function onApiCaptured(url) {
        const key = getUrlKey(url);
        const exists = state.capturedApis.find(a => getUrlKey(a.url) === key);
        if (exists) {
            // 更新为最新的 URL（可能包含更多页数信息）
            exists.url = url;
            exists.timestamp = Date.now();
        } else {
            const title = await fetchTitle(url);
            state.capturedApis.push({ url, title, timestamp: Date.now() });
            showToast('已捕获章节: ' + title);
        }
        renderCapturedList();
    }

    // ─── UI 实现 ──────────────────────────────────────────────────────────────
    let renderCapturedList = () => { };
    let renderQueueList = () => { };
    let showToast = () => { };
    let setProgress = () => { };

    function initUI() {
        if (!document.body) {
            window.addEventListener('DOMContentLoaded', initUI);
            return;
        }
        if (document.getElementById('cgd-panel')) return;

        const styles = `
            #cgd-panel {
                position: fixed; bottom: 20px; right: 20px; width: 320px;
                background: #1a1a2e; color: #e0e0e0; border: 1px solid #16213e;
                border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                font-family: sans-serif; font-size: 13px; z-index: 999999;
                display: flex; flex-direction: column; overflow: hidden;
            }
            #cgd-header {
                padding: 10px 15px; background: #16213e; cursor: move;
                display: flex; justify-content: space-between; align-items: center;
                border-bottom: 1px solid #0f3460;
            }
            #cgd-header b { color: #e94560; }
            #cgd-body { padding: 15px; display: flex; flex-direction: column; gap: 10px; }
            .cgd-section { border: 1px solid #16213e; border-radius: 4px; background: #16213e22; padding: 8px; }
            .cgd-label { font-size: 11px; color: #6e6e8e; text-transform: uppercase; margin-bottom: 5px; display: block; }
            .cgd-list { max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
            .cgd-item {
                display: flex; justify-content: space-between; align-items: center;
                background: #16213e; padding: 5px 8px; border-radius: 4px;
            }
            .cgd-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 10px; direction: rtl; text-align: left; }
            .cgd-btn-grp { display: flex; gap: 5px; }
            .cgd-btn-small {
                background: #0f3460; border: none; color: #e0e0e0;
                padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 11px;
            }
            .cgd-btn-small:hover { background: #e94560; }
            .cgd-btn-main {
                background: #0f3460; border: none; color: #fff; padding: 10px;
                border-radius: 4px; cursor: pointer; font-weight: bold; width: 100%;
            }
            .cgd-btn-main:hover { background: #e94560; }
            .cgd-btn-main:disabled { background: #333; cursor: not-allowed; }
            .cgd-mode-select { display: flex; gap: 5px; }
            .cgd-mode-btn {
                flex: 1; background: #16213e; border: 1px solid #0f3460;
                color: #888; padding: 5px; border-radius: 4px; font-size: 11px; cursor: pointer;
            }
            .cgd-mode-btn.active { background: #0f3460; color: #fff; border-color: #e94560; }
            #cgd-progress-box { display: none; margin-top: 10px; font-size: 11px; color: #888; }
            #cgd-progress-bar { height: 4px; background: #0f3460; width: 0%; transition: width 0.3s; margin-top: 4px; }
            #cgd-toast {
                position: fixed; bottom: 85px; right: 20px; background: #1a1a2e;
                color: #e94560; padding: 8px 15px; border-radius: 4px; border: 1px solid #e94560;
                z-index: 1000000; display: none;
            }
        `;
        const styleSheet = document.createElement('style');
        styleSheet.textContent = styles;
        document.head.appendChild(styleSheet);

        const panel = document.createElement('div');
        panel.id = 'cgd-panel';
        panel.innerHTML = `
            <div id="cgd-header">
                <b>Comic-Growl Downloader</b>
                <span id="cgd-toggle" style="cursor:pointer">[ - ]</span>
            </div>
            <div id="cgd-body">
                <div class="cgd-section">
                    <span class="cgd-label">Captured</span>
                    <div id="cgd-captured" class="cgd-list"></div>
                </div>
                <div class="cgd-section">
                    <span class="cgd-label">Queue</span>
                    <div id="cgd-queue" class="cgd-list"></div>
                </div>
                <div>
                    <span class="cgd-label">Mode</span>
                    <div class="cgd-mode-select">
                        <button class="cgd-mode-btn active" data-mode="0">Single</button>
                        <button class="cgd-mode-btn" data-mode="1">R-Cover</button>
                        <button class="cgd-mode-btn" data-mode="2">R-Main</button>
                    </div>
                </div>
                <div id="cgd-progress-box">
                    <div id="cgd-progress-text">Ready</div>
                    <div id="cgd-progress-bar"></div>
                </div>
                <button id="cgd-download-btn" class="cgd-btn-main">DOWNLOAD</button>
            </div>
        `;
        document.body.appendChild(panel);

        const toast = document.createElement('div');
        toast.id = 'cgd-toast';
        document.body.appendChild(toast);

        // UI 绑点
        const capturedEl = document.getElementById('cgd-captured');
        const queueEl = document.getElementById('cgd-queue');
        const dlBtn = document.getElementById('cgd-download-btn');
        const progBox = document.getElementById('cgd-progress-box');
        const progText = document.getElementById('cgd-progress-text');
        const progBar = document.getElementById('cgd-progress-bar');

        showToast = (msg) => {
            toast.textContent = msg;
            toast.style.display = 'block';
            setTimeout(() => toast.style.display = 'none', 3000);
        };

        setProgress = (pct, text) => {
            progBox.style.display = 'block';
            progBar.style.width = pct + '%';
            progText.textContent = text;
        };

        renderCapturedList = () => {
            capturedEl.innerHTML = state.capturedApis.length === 0 ? '<small style="color:#444">Waiting for requests...</small>' : '';
            state.capturedApis.forEach(api => {
                const item = document.createElement('div');
                item.className = 'cgd-item';
                item.innerHTML = `
                    <span title="${api.title}"><bdi>${api.title}</bdi></span>
                    <div class="cgd-btn-grp">
                        <button class="cgd-btn-small btn-add">[ + ]</button>
                        <button class="cgd-btn-small btn-cp">[ cp ]</button>
                    </div>
                `;
                item.querySelector('.btn-add').onclick = () => addToQueue(api);
                item.querySelector('.btn-cp').onclick = () => {
                    navigator.clipboard.writeText(api.url);
                    showToast('URL Copied');
                };
                capturedEl.appendChild(item);
            });
        };

        renderQueueList = () => {
            queueEl.innerHTML = state.downloadQueue.length === 0 ? '<small style="color:#444">Queue is empty</small>' : '';
            state.downloadQueue.forEach((api, idx) => {
                const item = document.createElement('div');
                item.className = 'cgd-item';
                item.innerHTML = `
                    <span title="${api.title}"><bdi>${api.title}</bdi></span>
                    <button class="cgd-btn-small btn-rm">[ x ]</button>
                `;
                item.querySelector('.btn-rm').onclick = () => {
                    state.downloadQueue.splice(idx, 1);
                    renderQueueList();
                };
                queueEl.appendChild(item);
            });
        };

        function addToQueue(api) {
            if (state.downloadQueue.some(q => q.url === api.url)) {
                showToast('Already in queue');
                return;
            }
            state.downloadQueue.push({ ...api });
            renderQueueList();
        }

        // 模式切换
        document.querySelectorAll('.cgd-mode-btn').forEach(btn => {
            btn.onclick = () => {
                state.mode = parseInt(btn.dataset.mode);
                document.querySelectorAll('.cgd-mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            };
        });

        // 拖拽、折叠
        let dragging = false, offset = { x: 0, y: 0 };
        const header = document.getElementById('cgd-header');
        header.onmousedown = (e) => {
            dragging = true;
            offset.x = e.clientX - panel.offsetLeft;
            offset.y = e.clientY - panel.offsetTop;
        };
        window.onmousemove = (e) => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offset.x) + 'px';
            panel.style.top = (e.clientY - offset.y) + 'px';
            panel.style.bottom = 'auto'; panel.style.right = 'auto';
        };
        window.onmouseup = () => dragging = false;

        document.getElementById('cgd-toggle').onclick = () => {
            const b = document.getElementById('cgd-body');
            const show = b.style.display === 'none';
            b.style.display = show ? 'flex' : 'none';
            document.getElementById('cgd-toggle').textContent = show ? '[ - ]' : '[ + ]';
        };

        dlBtn.onclick = startProcess;
    }

    // ─── 下载与处理核心 ─────────────────────────────────────────────────────────

    async function gmFetch(url, responseType = 'text', retries = 3) {
        for (let i = 0; i <= retries; i++) {
            try {
                return await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET', url, responseType,
                        headers: { 'Referer': window.location.href, 'User-Agent': navigator.userAgent },
                        onload: r => r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error('HTTP ' + r.status)),
                        onerror: e => reject(e)
                    });
                });
            } catch (err) {
                if (i === retries) throw err;
                const delay = 1000 * Math.pow(2, i);
                console.warn(`[CGD] Fetch failed, retrying in ${delay}ms...`, err);
                await sleep(delay);
            }
        }
    }

    async function downloadAndDecode(imgInfo) {
        const { imageUrl, scramble, width, height } = imgInfo;
        const blob = await gmFetch(imageUrl, 'blob');
        const img = await new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const i = new Image();
            i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
            i.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode error')); };
            i.src = url;
        });

        const n = 4;
        const mainWidth = Math.floor(width / n) * n;
        const blockW = Math.floor(mainWidth / n);
        const blockH = Math.floor(height / n);
        const scr = scramble.replace(/\s/g, '').replace(/^\[|\]$/g, '').split(',').map(Number);

        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');

        for (let pos = 0; pos < n * n; pos++) {
            const blockNum = scr[pos];
            const pR = pos % n, pC = Math.floor(pos / n);
            const sR = blockNum % n, sC = Math.floor(blockNum / n);
            ctx.drawImage(img, sC * blockW, sR * blockH, blockW, blockH, pC * blockW, pR * blockH, blockW, blockH);
        }
        if (width > mainWidth) {
            ctx.drawImage(img, mainWidth, 0, width - mainWidth, height, mainWidth, 0, width - mainWidth, height);
        }
        return canvas;
    }

    async function startProcess() {
        if (state.downloadQueue.length === 0) return showToast('Queue is empty');
        if (state.isDownloading) return;

        state.isDownloading = true;
        const dlBtn = document.getElementById('cgd-download-btn');
        dlBtn.disabled = true;
        dlBtn.textContent = 'WORKING...';

        try {
            const firstChapter = state.downloadQueue[0];
            const folderName = document.title.split('|')[0].trim().replace(/[\\/:*?"<>|]/g, '_') || 'Comic';
            const resumeKey = STORAGE_KEY_PREFIX + folderName;
            
            // 下載目錄選擇
            let subDir = null;
            if (window.showDirectoryPicker) {
                try {
                    const baseDir = await window.showDirectoryPicker({ mode: 'readwrite' });
                    subDir = await baseDir.getDirectoryHandle(folderName, { create: true });
                    showToast('Saving to ' + folderName);
                } catch (e) {
                    showToast('Canceled or no access. Using default download directory.');
                }
            }

            const saveFile = async (blob, fileName) => {
                if (subDir) {
                    const fh = await subDir.getFileHandle(fileName, { create: true });
                    const w = await fh.createWritable();
                    await w.write(blob); await w.close();
                } else {
                    return new Promise((res, rej) => {
                        const url = URL.createObjectURL(blob);
                        GM_download({
                            url, name: folderName + '/' + fileName,
                            onload: () => { URL.revokeObjectURL(url); res(); },
                            onerror: (e) => rej(e)
                        });
                    });
                }
            };

            // 合并列表
            setProgress(0, 'Fetching lists...');
            let allImages = [];
            for (const q of state.downloadQueue) {
                const res = await gmFetch(q.url, 'text');
                const data = JSON.parse(res);
                allImages = allImages.concat(data.result.images || data.result); // 兼容性检查
            }
            const total = allImages.length;

            // 检查断点
            let startIdx = 0;
            const saved = localStorage.getItem(resumeKey);
            if (saved) {
                const resumeData = JSON.parse(saved);
                if (resumeData.total === total && confirm(`Resume from page ${resumeData.current + 1}?`)) {
                    startIdx = resumeData.current;
                }
            }

            if (state.mode === 0) {
                // Single Page Loop
                for (let i = startIdx; i < total; i++) {
                    setProgress(Math.floor((i / total) * 100), `Downloading ${i + 1}/${total}`);
                    const canvas = await downloadAndDecode(allImages[i]);
                    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
                    await saveFile(blob, `page_${String(i + 1).padStart(3, '0')}.jpg`);
                    localStorage.setItem(resumeKey, JSON.stringify({ current: i + 1, total }));
                }
            } else {
                // Sliding Window Spreads
                const getCanvas = async (idx) => idx < total ? await downloadAndDecode(allImages[idx]) : null;
                const canvasToBlob = (c) => new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));

                const combine = (l, r) => {
                    const w = l ? l.width : r.width;
                    const h = l ? l.height : r.height;
                    const res = document.createElement('canvas');
                    res.width = w * 2; res.height = h;
                    const ctx = res.getContext('2d');
                    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, res.width, res.height);
                    if (l) ctx.drawImage(l, 0, 0);
                    if (r) ctx.drawImage(r, w, 0);
                    return res;
                };

                let i = startIdx;
                // 注意：断点续传在拼页模式下为了简单起见，如果从中间恢复，可能逻辑比较复杂。
                // 这里简写：如果是拼页模式，startIdx 必须是偶数（如果从 Mode 1 开始）或处理 Offset。
                
                // 处理第一页（封面）
                if (i === 0) {
                    if (state.mode === 1) { // 封面在右
                        const c1 = await getCanvas(0);
                        const c2 = await getCanvas(1);
                        const spread = combine(c2, c1);
                        await saveFile(await canvasToBlob(spread), 'spread_001.jpg');
                        i = 2;
                    } else if (state.mode === 2) { // 封面单独在左
                        const c1 = await getCanvas(0);
                        const spread = combine(c1, null);
                        await saveFile(await canvasToBlob(spread), 'spread_001.jpg');
                        i = 1;
                    }
                }

                // 剩余循环
                let spreadCount = Math.floor(i / 2) + 1;
                while (i < total) {
                    const r = await getCanvas(i);
                    const l = await getCanvas(i + 1);
                    const spread = combine(l, r);
                    spreadCount++;
                    await saveFile(await canvasToBlob(spread), `spread_${String(spreadCount).padStart(3, '0')}.jpg`);
                    i += 2;
                    localStorage.setItem(resumeKey, JSON.stringify({ current: i, total }));
                }
            }

            localStorage.removeItem(resumeKey);
            setProgress(100, 'FINISHED');
            showToast('Finished downloading!');
        } catch (err) {
            console.error(err);
            showToast('Error: ' + err.message);
            setProgress(0, 'Failed');
        } finally {
            state.isDownloading = false;
            dlBtn.disabled = false;
            dlBtn.textContent = 'DOWNLOAD';
        }
    }

    // 启动：网络拦截在全站生效，UI 仅在章节页初始化
    setupInterception();

    function ensureUI() {
        if (isEpisodePage() && !document.getElementById('cgd-panel')) initUI();
    }

    // 监听 SPA 路由变化（pushState / replaceState / popstate / DOM 变更）
    const pageWinBoot = getPageWin();
    const origPush = pageWinBoot.history.pushState.bind(pageWinBoot.history);
    const origReplace = pageWinBoot.history.replaceState.bind(pageWinBoot.history);
    pageWinBoot.history.pushState = function (...a) { origPush(...a); ensureUI(); };
    pageWinBoot.history.replaceState = function (...a) { origReplace(...a); ensureUI(); };
    window.addEventListener('popstate', ensureUI);

    const observer = new MutationObserver(() => ensureUI());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    ensureUI();

})();
