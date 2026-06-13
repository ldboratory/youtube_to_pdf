/* ===== 로그 패널 ===== */
const logOutput   = document.getElementById('logOutput');
const logToggle   = document.getElementById('logToggle');
const clearLogBtn = document.getElementById('clearLogBtn');

function log(msg, level = 'info') {
    if (!logToggle || !logToggle.checked) return;
    const line = document.createElement('div');
    line.className = `log-line ${level}`;
    const now = new Date();
    const ts  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    line.textContent = `[${ts}] ${msg}`;
    logOutput.appendChild(line);
    logOutput.scrollTop = logOutput.scrollHeight;
    while (logOutput.children.length > 200) logOutput.removeChild(logOutput.firstChild);
}

window.addEventListener('error', e => log(`ERROR: ${e.message} (${e.lineno}줄)`, 'error'));
window.addEventListener('unhandledrejection', e => log(`UNHANDLED: ${e.reason}`, 'error'));
clearLogBtn.addEventListener('click', () => { logOutput.innerHTML = ''; });

/* ===== 플랫폼 감지 ===== */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const hasDisplayMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
// iOS는 displayMedia 미지원 → direct 모드
const defaultMode = hasDisplayMedia ? 'screen' : 'direct';

log(`플랫폼: ${isIOS ? 'iOS' : '데스크탑/안드로이드'} | getDisplayMedia: ${hasDisplayMedia} | 모드: ${defaultMode}`, 'info');

/* ===== 상태 ===== */
const state = {
    mode: defaultMode,       // 'screen' | 'direct'
    videoId: null,
    videoLoaded: false,
    // screen 모드
    screenStream: null,
    // direct 모드
    directLoaded: false,
    // 공통
    region: null,            // { x, y, w, h } — 캡처 소스 내 픽셀 좌표
    captures: [],
    autoRunning: false,
    autoTimer: null,
    prevImageData: null,
    captureCount: 0,
};

/* ===== DOM ===== */
const $ = id => document.getElementById(id);
const youtubeUrlInput  = $('youtubeUrl');
const loadBtn          = $('loadBtn');
const ytPlayer         = $('ytPlayer');
const directVideoEl    = $('directVideoEl');
const placeholder      = $('placeholder');
const overlayCanvas    = $('overlayCanvas');
const screenVideo      = $('screenVideo');
const workCanvas       = $('workCanvas');
const workCtx          = workCanvas.getContext('2d');
const screenCaptureBtn = $('screenCaptureBtn');
const selectRegionBtn  = $('selectRegionBtn');
const manualCaptureBtn = $('manualCaptureBtn');
const autoCaptureChk   = $('autoCapture');
const checkIntervalIn  = $('checkInterval');
const sensitivityIn    = $('sensitivity');
const statusBar        = $('statusBar');
const captureCountEl   = $('captureCount');
const captureList      = $('captureList');
const exportPdfBtn     = $('exportPdfBtn');
const clearBtn         = $('clearBtn');
const regionModal      = $('regionModal');
const regionCanvas     = $('regionCanvas');

/* ===== iOS 모드: 화면공유 버튼 → 로딩 상태 표시로 교체 ===== */
if (!hasDisplayMedia) {
    screenCaptureBtn.textContent = '📱 iOS 모드 (자동)';
    screenCaptureBtn.style.background = '#555';
    screenCaptureBtn.disabled = true;
    log('iOS/모바일: 화면공유 불가 → Piped API 직접 로드 모드', 'warn');
}

/* ===== 유튜브 ID 추출 ===== */
function extractVideoId(url) {
    try {
        const u = new URL(url.trim());
        if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
        if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    } catch (_) {}
    const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

function toEmbedUrl(videoId) {
    return `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0`;
}

/* ===== Piped API 인스턴스 + CORS 프록시 ===== */
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://piped-api.garudalinux.org',
    'https://api.piped.yt',
    'https://pipedapi.reallyaweso.me',
];

// CORS 프록시: 직접 요청 실패 시 사용
const CORS_PROXIES = [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

async function tryFetch(url, timeoutMs = 8000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function fetchPipedStreams(videoId) {
    // 1단계: 직접 요청
    for (const base of PIPED_INSTANCES) {
        try {
            log(`Piped 직접 시도: ${base}`, 'info');
            const data = await tryFetch(`${base}/streams/${videoId}`);
            log(`Piped 성공: ${base}`, 'ok');
            return data;
        } catch (e) {
            log(`Piped 실패 (${base}): ${e.message}`, 'warn');
        }
    }

    // 2단계: CORS 프록시 경유
    log('직접 요청 전부 실패 → CORS 프록시 시도', 'warn');
    for (const proxyFn of CORS_PROXIES) {
        for (const base of PIPED_INSTANCES.slice(0, 2)) {
            const proxied = proxyFn(`${base}/streams/${videoId}`);
            try {
                log(`프록시 시도: ${proxied.substring(0, 60)}...`, 'info');
                const data = await tryFetch(proxied, 12000);
                log('CORS 프록시 성공', 'ok');
                return data;
            } catch (e) {
                log(`프록시 실패: ${e.message}`, 'warn');
            }
        }
    }

    throw new Error('모든 Piped 인스턴스와 프록시에 실패했습니다');
}

/* ===== 영상 불러오기 ===== */
loadBtn.addEventListener('click', async () => {
    const url = youtubeUrlInput.value.trim();
    const videoId = extractVideoId(url);
    if (!videoId) {
        setStatus('올바른 유튜브 URL이 아닙니다', 'warning');
        log(`URL 파싱 실패: "${url}"`, 'warn');
        return;
    }

    state.videoId = videoId;
    log(`영상 ID: ${videoId} | 모드: ${state.mode}`, 'info');

    if (state.mode === 'screen') {
        // 데스크탑: iframe으로 재생, 화면공유로 캡처
        ytPlayer.src = toEmbedUrl(videoId);
        ytPlayer.style.display = 'block';
        placeholder.style.display = 'none';
        state.videoLoaded = true;
        screenCaptureBtn.disabled = false;
        log(`iframe 로드: ${toEmbedUrl(videoId)}`, 'ok');
        setStatus('영상 로드됨 — "화면 공유 시작"을 눌러주세요', 'active');
    } else {
        // iOS/direct 모드: Piped API로 직접 스트림 URL 획득
        await loadDirectVideo(videoId);
    }
});

youtubeUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadBtn.click(); });

async function loadDirectVideo(videoId) {
    setStatus('영상 정보 가져오는 중...', 'capturing');
    loadBtn.disabled = true;

    try {
        const data = await fetchPipedStreams(videoId);
        log(`응답 키: ${Object.keys(data).join(', ')}`, 'info');

        // HLS 우선 (iOS Safari 네이티브 지원, 프록시 서버 경유라 CORS OK)
        let videoUrl = null;
        let videoType = null;

        if (data.hls) {
            log(`HLS 스트림 발견: ${data.hls.substring(0, 80)}...`, 'ok');
            videoUrl = data.hls;
            videoType = 'application/x-mpegURL';
        } else {
            // HLS 없으면 mp4 스트림 선택
            const streams = (data.videoStreams || [])
                .filter(s => s.mimeType && s.mimeType.includes('video/mp4') && s.url)
                .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

            log(`mp4 스트림: ${streams.map(s => s.quality).join(', ')}`, 'info');
            if (!streams.length) throw new Error('사용 가능한 스트림 없음');

            const chosen = streams[0];
            log(`선택: ${chosen.quality} | ${chosen.mimeType}`, 'ok');
            videoUrl = chosen.url;
            videoType = chosen.mimeType;
        }

        log(`최종 URL (앞 80자): ${videoUrl.substring(0, 80)}...`, 'info');

        directVideoEl.src = videoUrl;
        if (videoType) directVideoEl.type = videoType;
        directVideoEl.style.display = 'block';
        ytPlayer.style.display = 'none';
        placeholder.style.display = 'none';

        await new Promise((resolve, reject) => {
            directVideoEl.onloadedmetadata = () => {
                log(`메타 로드 완료: ${directVideoEl.videoWidth}×${directVideoEl.videoHeight}`, 'ok');
                resolve();
            };
            directVideoEl.onerror = () => {
                const err = directVideoEl.error;
                reject(new Error(`영상 오류 code=${err ? err.code : '?'} msg="${err ? err.message : ''}" src=${videoUrl.substring(0,60)}`));
            };
            setTimeout(() => reject(new Error('타임아웃 (20초)')), 20000);
        });

        state.videoLoaded = true;
        state.directLoaded = true;
        selectRegionBtn.disabled = false;
        manualCaptureBtn.disabled = false;
        setStatus('영상 로드됨 — "구역 선택"으로 캡처할 영역을 지정하세요', 'active');

    } catch (err) {
        log(`직접 로드 실패: ${err.message}`, 'error');
        // 폴백: iframe으로라도 재생 (캡처는 안 되지만 볼 수 있음)
        ytPlayer.src = toEmbedUrl(videoId);
        ytPlayer.style.display = 'block';
        placeholder.style.display = 'none';
        setStatus(`⚠️ 직접 로드 실패 — iframe으로 재생 중 (캡처 불가): ${err.message}`, 'warning');
    } finally {
        loadBtn.disabled = false;
    }
}

/* ===== 화면 공유 (데스크탑 전용) ===== */
screenCaptureBtn.addEventListener('click', async () => {
    if (state.mode !== 'screen') return;

    if (state.screenStream) {
        stopScreenShare();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false,
        });

        state.screenStream = stream;
        screenVideo.srcObject = stream;
        await screenVideo.play();

        const track = stream.getVideoTracks()[0];
        const s = track.getSettings();
        log(`화면 공유 시작: ${s.width}×${s.height} @${s.frameRate}fps`, 'ok');
        track.addEventListener('ended', stopScreenShare);

        screenCaptureBtn.textContent = '🖥️ 화면 공유 중지';
        screenCaptureBtn.style.background = '#555';
        selectRegionBtn.disabled = false;
        manualCaptureBtn.disabled = false;
        setStatus('화면 공유 시작됨 — "구역 선택"으로 캡처 영역을 지정하세요', 'active');
    } catch (err) {
        if (err.name !== 'NotAllowedError') {
            log(`화면 공유 실패: ${err.name} — ${err.message}`, 'error');
            setStatus('화면 공유 실패: ' + err.message, 'warning');
        } else {
            log('화면 공유 취소 (사용자)', 'warn');
            setStatus('화면 공유가 취소되었습니다', '');
        }
    }
});

function stopScreenShare() {
    if (state.screenStream) {
        state.screenStream.getTracks().forEach(t => t.stop());
        state.screenStream = null;
    }
    stopAutoCapture();
    screenCaptureBtn.textContent = '🖥️ 화면 공유 시작';
    screenCaptureBtn.style.background = '';
    selectRegionBtn.disabled = true;
    manualCaptureBtn.disabled = true;
    autoCaptureChk.checked = false;
    state.region = null;
    clearOverlay();
    setStatus('화면 공유가 종료되었습니다', 'warning');
    log('화면 공유 종료', 'warn');
}

/* ===== 구역 선택 모달 ===== */
let dragStart = null;
let dragEnd   = null;

selectRegionBtn.addEventListener('click', openRegionModal);

function openRegionModal() {
    regionCanvas.width  = window.innerWidth;
    regionCanvas.height = window.innerHeight;
    regionModal.style.display = 'block';
    drawRegionOverlay(null);
    log('구역 선택 모달 열림', 'info');
}

function closeRegionModal() {
    regionModal.style.display = 'none';
    dragStart = null;
    dragEnd   = null;
}

regionCanvas.addEventListener('mousedown',  onDragStart);
regionCanvas.addEventListener('mousemove',  onDragMove);
regionCanvas.addEventListener('mouseup',    onDragEnd);
regionCanvas.addEventListener('touchstart', e => { e.preventDefault(); onDragStart(e.touches[0]); }, { passive: false });
regionCanvas.addEventListener('touchmove',  e => { e.preventDefault(); onDragMove(e.touches[0]);  }, { passive: false });
regionCanvas.addEventListener('touchend',   e => { e.preventDefault(); onDragEnd(e.changedTouches[0]); }, { passive: false });

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRegionModal(); });

function clientPos(e) { return { x: e.clientX, y: e.clientY }; }

function onDragStart(e) { dragStart = clientPos(e); dragEnd = null; }
function onDragMove(e)  { if (!dragStart) return; dragEnd = clientPos(e); drawRegionOverlay({ start: dragStart, end: dragEnd }); }

function onDragEnd(e) {
    if (!dragStart) return;
    dragEnd = clientPos(e);

    const cssX = Math.min(dragStart.x, dragEnd.x);
    const cssY = Math.min(dragStart.y, dragEnd.y);
    const cssW = Math.abs(dragEnd.x - dragStart.x);
    const cssH = Math.abs(dragEnd.y - dragStart.y);

    if (cssW < 10 || cssH < 10) {
        closeRegionModal();
        setStatus('너무 작은 영역입니다. 다시 선택해주세요', 'warning');
        return;
    }

    if (state.mode === 'direct') {
        // direct 모드: 비디오 요소 기준 상대 좌표로 변환
        const rect = directVideoEl.getBoundingClientRect();
        const scaleX = directVideoEl.videoWidth  / rect.width;
        const scaleY = directVideoEl.videoHeight / rect.height;
        const rx = (cssX - rect.left) * scaleX;
        const ry = (cssY - rect.top)  * scaleY;
        const rw = cssW * scaleX;
        const rh = cssH * scaleY;
        state.region = { x: rx, y: ry, w: rw, h: rh };
        log(`구역 설정 (direct): 비디오 픽셀 (${Math.round(rx)},${Math.round(ry)}) ${Math.round(rw)}×${Math.round(rh)}px`, 'ok');
    } else {
        // screen 모드: 화면 픽셀 좌표
        const dpr = window.devicePixelRatio || 1;
        state.region = { x: cssX * dpr, y: cssY * dpr, w: cssW * dpr, h: cssH * dpr };
        log(`구역 설정 (screen): ${Math.round(cssW)}×${Math.round(cssH)}px CSS | dpr=${dpr}`, 'ok');
    }

    closeRegionModal();
    drawSelectedOverlay({ x: cssX, y: cssY, w: cssW, h: cssH });
    state.prevImageData = null;
    setStatus(`구역 설정됨 (${Math.round(cssW)}×${Math.round(cssH)}px) — 캡처 준비 완료`, 'active');
}

function drawRegionOverlay(sel) {
    const ctx = regionCanvas.getContext('2d');
    ctx.clearRect(0, 0, regionCanvas.width, regionCanvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);
    if (!sel) return;
    const x = Math.min(sel.start.x, sel.end.x);
    const y = Math.min(sel.start.y, sel.end.y);
    const w = Math.abs(sel.end.x - sel.start.x);
    const h = Math.abs(sel.end.y - sel.start.y);
    ctx.clearRect(x, y, w, h);
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#e53935';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${Math.round(w)} × ${Math.round(h)}`, x + 4, y > 20 ? y - 6 : y + h + 16);
}

function drawSelectedOverlay(cssRect) {
    const wrapper = document.getElementById('videoWrapper');
    const wRect   = wrapper.getBoundingClientRect();
    overlayCanvas.width  = wrapper.offsetWidth;
    overlayCanvas.height = wrapper.offsetHeight;
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const rx = cssRect.x - wRect.left;
    const ry = cssRect.y - wRect.top;
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(rx, ry, cssRect.w, cssRect.h);
    ctx.fillStyle = 'rgba(229,57,53,0.08)';
    ctx.fillRect(rx, ry, cssRect.w, cssRect.h);
}

function clearOverlay() {
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

/* ===== 구역 캡처 ===== */
function getSourceVideo() {
    return state.mode === 'direct' ? directVideoEl : screenVideo;
}

function captureRegion() {
    if (!state.region) return null;
    const src = getSourceVideo();
    const vw = src.videoWidth;
    const vh = src.videoHeight;
    if (!vw || !vh) { log('captureRegion: 소스 비디오 준비 안 됨', 'warn'); return null; }

    const { x, y, w, h } = state.region;
    const cx = Math.max(0, Math.min(x, vw - 1));
    const cy = Math.max(0, Math.min(y, vh - 1));
    const cw = Math.min(w, vw - cx);
    const ch = Math.min(h, vh - cy);
    if (cw <= 0 || ch <= 0) { log('captureRegion: 구역이 소스 밖', 'warn'); return null; }

    workCanvas.width  = cw;
    workCanvas.height = ch;
    workCtx.drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch);

    try {
        return workCanvas.toDataURL('image/jpeg', 0.88);
    } catch (e) {
        if (e.name === 'SecurityError') {
            log(`CORS 차단: 이 스트림은 캔버스 읽기가 막혀있습니다 (${e.message})`, 'error');
            setStatus('⚠️ CORS 오류: 이 영상은 캡처할 수 없습니다. 다른 Piped 서버를 시도 중...', 'warning');
            tryNextPipedInstance();
        } else {
            log(`toDataURL 실패: ${e.message}`, 'error');
        }
        return null;
    }
}

/* CORS 실패 시 다른 Piped 인스턴스 재시도 */
let pipedInstanceIdx = 0;
async function tryNextPipedInstance() {
    if (!state.videoId) return;
    pipedInstanceIdx = (pipedInstanceIdx + 1) % PIPED_INSTANCES.length;
    if (pipedInstanceIdx === 0) {
        log('모든 Piped 인스턴스 시도 완료 — 캡처 불가', 'error');
        return;
    }
    log(`다음 Piped 인스턴스 시도 (${pipedInstanceIdx}번째)...`, 'info');
    stopAutoCapture();
    autoCaptureChk.checked = false;
    await loadDirectVideo(state.videoId);
}

/* ===== 변화 감지 ===== */
function hasChanged() {
    if (!state.region) return false;
    const src = getSourceVideo();
    const vw = src.videoWidth;
    const vh = src.videoHeight;
    if (!vw || !vh) return false;

    const { x, y, w, h } = state.region;
    const cx = Math.max(0, Math.min(x, vw - 1));
    const cy = Math.max(0, Math.min(y, vh - 1));
    const cw = Math.min(w, vw - cx);
    const ch = Math.min(h, vh - cy);
    if (cw <= 0 || ch <= 0) return false;

    const tw = Math.min(cw, 160);
    const th = Math.round(ch * (tw / cw));
    workCanvas.width  = tw;
    workCanvas.height = th;
    workCtx.drawImage(src, cx, cy, cw, ch, 0, 0, tw, th);

    let current;
    try {
        current = workCtx.getImageData(0, 0, tw, th).data;
    } catch (e) {
        // SecurityError: tainted canvas (CORS)
        return false;
    }

    if (!state.prevImageData || state.prevImageData.length !== current.length) {
        state.prevImageData = current.slice();
        return false;
    }

    const threshold = (parseInt(sensitivityIn.value) || 5) * 3;
    let diffPixels = 0;
    for (let i = 0; i < current.length; i += 4) {
        if (Math.abs(current[i]   - state.prevImageData[i])   > threshold ||
            Math.abs(current[i+1] - state.prevImageData[i+1]) > threshold ||
            Math.abs(current[i+2] - state.prevImageData[i+2]) > threshold) {
            diffPixels++;
        }
    }

    if (diffPixels / (tw * th) > 0.02) {
        state.prevImageData = current.slice();
        return true;
    }
    return false;
}

/* ===== 수동 캡처 ===== */
manualCaptureBtn.addEventListener('click', () => {
    if (!state.region) {
        setStatus('"구역 선택"으로 영역을 먼저 지정해주세요', 'warning');
        return;
    }
    const dataUrl = captureRegion();
    if (dataUrl) {
        addCapture(dataUrl);
        log(`수동 캡처 #${state.captures.length} 완료`, 'capture');
        setStatus(`캡처됨 (총 ${state.captures.length}개)`, 'capturing');
    } else {
        log('수동 캡처 실패', 'error');
        setStatus('캡처 실패 — 로그를 확인하세요', 'warning');
    }
});

/* ===== 자동 캡처 ===== */
autoCaptureChk.addEventListener('change', () => {
    if (autoCaptureChk.checked) {
        if (!state.region) {
            autoCaptureChk.checked = false;
            setStatus('"구역 선택"으로 영역을 먼저 지정해주세요', 'warning');
            return;
        }
        startAutoCapture();
    } else {
        stopAutoCapture();
    }
});

function startAutoCapture() {
    state.autoRunning = true;
    const ms = parseFloat(checkIntervalIn.value) * 1000 || 1500;
    log(`자동 캡처 시작 (간격 ${ms}ms, 민감도 ${sensitivityIn.value})`, 'info');
    setStatus('자동 캡처 중... (변화 감지)', 'capturing');

    function tick() {
        if (!state.autoRunning) return;
        if (hasChanged()) {
            const dataUrl = captureRegion();
            if (dataUrl) {
                addCapture(dataUrl);
                log(`변화 감지 → 자동 캡처 #${state.captures.length}`, 'capture');
                setStatus(`변화 감지 → 캡처됨 (총 ${state.captures.length}개)`, 'capturing');
            } else {
                log('변화 감지됐으나 캡처 실패', 'warn');
            }
        }
        state.autoTimer = setTimeout(tick, ms);
    }
    tick();
}

function stopAutoCapture() {
    state.autoRunning = false;
    clearTimeout(state.autoTimer);
    if (state.videoLoaded) {
        setStatus(`자동 캡처 중지됨 (총 ${state.captures.length}개)`, 'active');
        log('자동 캡처 중지', 'info');
    }
}

/* ===== 캡처 목록 ===== */
function addCapture(dataUrl) {
    state.captureCount++;
    const id = state.captureCount;
    state.captures.push({ id, dataUrl });

    const emptyHint = captureList.querySelector('.empty-hint');
    if (emptyHint) emptyHint.remove();

    const item = document.createElement('div');
    item.className = 'capture-item';
    item.dataset.id = id;

    const img = document.createElement('img');
    img.src = dataUrl;
    img.loading = 'lazy';

    const label = document.createElement('div');
    label.className = 'cap-label';

    const num = document.createElement('span');
    num.textContent = `#${id}`;

    const del = document.createElement('button');
    del.className = 'cap-delete';
    del.textContent = '✕';
    del.addEventListener('click', e => { e.stopPropagation(); removeCapture(id, item); });

    label.appendChild(num);
    label.appendChild(del);
    item.appendChild(img);
    item.appendChild(label);
    captureList.appendChild(item);

    captureCountEl.textContent = state.captures.length;
    exportPdfBtn.disabled = false;
    captureList.scrollTop = captureList.scrollHeight;
}

function removeCapture(id, el) {
    state.captures = state.captures.filter(c => c.id !== id);
    el.remove();
    captureCountEl.textContent = state.captures.length;
    if (state.captures.length === 0) {
        captureList.innerHTML = '<p class="empty-hint">캡처된 이미지가 없습니다</p>';
        exportPdfBtn.disabled = true;
    }
}

/* ===== 전체 삭제 ===== */
clearBtn.addEventListener('click', () => {
    if (state.captures.length === 0) return;
    if (!confirm(`캡처된 ${state.captures.length}개 이미지를 모두 삭제할까요?`)) return;
    state.captures = [];
    captureList.innerHTML = '<p class="empty-hint">캡처된 이미지가 없습니다</p>';
    captureCountEl.textContent = '0';
    exportPdfBtn.disabled = true;
    state.captureCount = 0;
    setStatus('모두 삭제되었습니다', '');
    log('캡처 전체 삭제', 'warn');
});

/* ===== PDF 내보내기 ===== */
exportPdfBtn.addEventListener('click', async () => {
    if (state.captures.length === 0) return;
    setStatus('PDF 생성 중...', 'capturing');

    try {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm' });
        const pw  = pdf.internal.pageSize.getWidth();
        const ph  = pdf.internal.pageSize.getHeight();

        for (let i = 0; i < state.captures.length; i++) {
            if (i > 0) pdf.addPage();
            const img   = await loadImage(state.captures[i].dataUrl);
            const iw    = img.naturalWidth  || img.width;
            const ih    = img.naturalHeight || img.height;
            const ratio = Math.min(pw / iw, ph / ih);
            const dw = iw * ratio, dh = ih * ratio;
            pdf.addImage(state.captures[i].dataUrl, 'JPEG', (pw-dw)/2, (ph-dh)/2, dw, dh);
        }

        pdf.save(`youtube_capture_${Date.now()}.pdf`);
        log(`PDF 저장 완료 (${state.captures.length}페이지)`, 'ok');
        setStatus(`PDF 저장됨 (${state.captures.length}페이지)`, 'active');
    } catch (err) {
        log(`PDF 실패: ${err.message}`, 'error');
        setStatus('PDF 생성 실패: ' + err.message, 'warning');
    }
});

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

/* ===== 상태 바 ===== */
function setStatus(msg, type) {
    statusBar.textContent = msg;
    statusBar.className   = 'status-bar' + (type ? ' ' + type : '');
}

/* ===== 창 리사이즈 ===== */
window.addEventListener('resize', () => {
    if (state.region) {
        clearOverlay();
        state.region = null;
        state.prevImageData = null;
        log(`창 리사이즈 → 구역 초기화 (${window.innerWidth}×${window.innerHeight})`, 'warn');
        setStatus('창 크기가 변경되었습니다. 구역을 다시 선택해주세요', 'warning');
    }
});
