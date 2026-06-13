/* ===== 상태 ===== */
const state = {
    videoLoaded: false,
    screenStream: null,
    screenVideoEl: null,
    workCanvas: null,
    workCtx: null,
    region: null,          // { x, y, w, h } — 스크린 좌표 기준
    captures: [],
    autoRunning: false,
    autoTimer: null,
    prevImageData: null,
    captureCount: 0,
};

/* ===== DOM ===== */
const $ = id => document.getElementById(id);
const youtubeUrlInput = $('youtubeUrl');
const loadBtn         = $('loadBtn');
const ytPlayer        = $('ytPlayer');
const placeholder     = $('placeholder');
const overlayCanvas   = $('overlayCanvas');
const screenVideo     = $('screenVideo');
const workCanvas      = $('workCanvas');
const screenCaptureBtn= $('screenCaptureBtn');
const selectRegionBtn = $('selectRegionBtn');
const manualCaptureBtn= $('manualCaptureBtn');
const autoCaptureChk  = $('autoCapture');
const checkIntervalIn = $('checkInterval');
const sensitivityIn   = $('sensitivity');
const statusBar       = $('statusBar');
const captureCountEl  = $('captureCount');
const captureList     = $('captureList');
const exportPdfBtn    = $('exportPdfBtn');
const clearBtn        = $('clearBtn');
const regionModal     = $('regionModal');
const regionCanvas    = $('regionCanvas');

state.screenVideoEl = screenVideo;
state.workCanvas    = workCanvas;
state.workCtx       = workCanvas.getContext('2d');

/* ===== 유튜브 URL → embed URL ===== */
function toEmbedUrl(url) {
    let videoId = null;
    try {
        const u = new URL(url.trim());
        if (u.hostname.includes('youtu.be')) {
            videoId = u.pathname.slice(1);
        } else if (u.hostname.includes('youtube.com')) {
            videoId = u.searchParams.get('v');
        }
    } catch (_) {
        const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
        if (m) videoId = m[1];
    }
    if (!videoId) return null;
    return `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0`;
}

/* ===== 영상 불러오기 ===== */
loadBtn.addEventListener('click', () => {
    const url = youtubeUrlInput.value.trim();
    const embed = toEmbedUrl(url);
    if (!embed) {
        setStatus('올바른 유튜브 URL이 아닙니다', 'warning');
        return;
    }
    ytPlayer.src = embed;
    ytPlayer.style.display = 'block';
    placeholder.style.display = 'none';
    state.videoLoaded = true;
    screenCaptureBtn.disabled = false;
    setStatus('영상 로드됨 — 이제 "화면 공유 시작"을 눌러주세요', 'active');
});

youtubeUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadBtn.click();
});

/* ===== 화면 공유 시작 ===== */
screenCaptureBtn.addEventListener('click', async () => {
    try {
        // 이미 실행 중이면 중지
        if (state.screenStream) {
            stopScreenShare();
            return;
        }

        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false,
        });

        state.screenStream = stream;
        screenVideo.srcObject = stream;
        await screenVideo.play();

        stream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);

        screenCaptureBtn.textContent = '🖥️ 화면 공유 중지';
        screenCaptureBtn.style.background = '#555';
        selectRegionBtn.disabled = false;
        manualCaptureBtn.disabled = false;

        setStatus('화면 공유 시작됨 — "구역 선택"으로 캡처 영역을 지정하세요', 'active');
    } catch (err) {
        if (err.name !== 'NotAllowedError') {
            setStatus('화면 공유 실패: ' + err.message, 'warning');
        } else {
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
}

/* ===== 구역 선택 (전체 화면 드래그 모달) ===== */
let dragStart = null;
let dragEnd   = null;

selectRegionBtn.addEventListener('click', openRegionModal);

function openRegionModal() {
    // regionCanvas를 전체 화면으로
    regionCanvas.width  = window.innerWidth;
    regionCanvas.height = window.innerHeight;
    regionModal.style.display = 'block';
    drawRegionOverlay(null);
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

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeRegionModal();
});

function clientPos(e) {
    return { x: e.clientX, y: e.clientY };
}

function onDragStart(e) {
    dragStart = clientPos(e);
    dragEnd   = null;
}

function onDragMove(e) {
    if (!dragStart) return;
    dragEnd = clientPos(e);
    drawRegionOverlay({ start: dragStart, end: dragEnd });
}

function onDragEnd(e) {
    if (!dragStart) return;
    dragEnd = clientPos(e);

    const x = Math.min(dragStart.x, dragEnd.x);
    const y = Math.min(dragStart.y, dragEnd.y);
    const w = Math.abs(dragEnd.x - dragStart.x);
    const h = Math.abs(dragEnd.y - dragStart.y);

    if (w < 10 || h < 10) {
        closeRegionModal();
        setStatus('너무 작은 영역입니다. 다시 선택해주세요', 'warning');
        return;
    }

    // 화면 픽셀 비율 고려
    const dpr = window.devicePixelRatio || 1;
    state.region = { x: x * dpr, y: y * dpr, w: w * dpr, h: h * dpr };

    closeRegionModal();
    drawSelectedOverlay({ x, y, w, h }); // CSS px 기준으로 오버레이 표시
    state.prevImageData = null; // 이전 비교용 초기화
    setStatus(`구역 설정됨 (${Math.round(w)}×${Math.round(h)}px) — 캡처 준비 완료`, 'active');
}

function drawRegionOverlay(sel) {
    const ctx = regionCanvas.getContext('2d');
    ctx.clearRect(0, 0, regionCanvas.width, regionCanvas.height);

    // 반투명 어두운 배경
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);

    if (!sel) return;
    const x = Math.min(sel.start.x, sel.end.x);
    const y = Math.min(sel.start.y, sel.end.y);
    const w = Math.abs(sel.end.x - sel.start.x);
    const h = Math.abs(sel.end.y - sel.start.y);

    // 선택 영역 투명하게 뚫기
    ctx.clearRect(x, y, w, h);
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // 크기 표시
    ctx.fillStyle = '#e53935';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${Math.round(w)} × ${Math.round(h)}`, x + 4, y > 20 ? y - 6 : y + h + 16);
}

/* ===== 오버레이에 선택된 구역 표시 ===== */
function drawSelectedOverlay(cssRect) {
    const wrapper = document.getElementById('videoWrapper');
    const wRect   = wrapper.getBoundingClientRect();

    overlayCanvas.width  = wrapper.offsetWidth;
    overlayCanvas.height = wrapper.offsetHeight;

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // wrapper 기준 상대 좌표로 변환
    const rx = cssRect.x - wRect.left;
    const ry = cssRect.y - wRect.top;
    const rw = cssRect.w;
    const rh = cssRect.h;

    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.fillStyle = 'rgba(229,57,53,0.08)';
    ctx.fillRect(rx, ry, rw, rh);
}

function clearOverlay() {
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

/* ===== 화면에서 구역 캡처 ===== */
function captureRegion() {
    if (!state.screenStream || !state.region) return null;

    const sv = state.screenVideoEl;
    const wc = state.workCanvas;
    const ctx = state.workCtx;

    const vw = sv.videoWidth;
    const vh = sv.videoHeight;
    if (!vw || !vh) return null;

    const { x, y, w, h } = state.region;

    // 구역이 화면 밖으로 나가지 않도록 클램프
    const cx = Math.max(0, Math.min(x, vw - 1));
    const cy = Math.max(0, Math.min(y, vh - 1));
    const cw = Math.min(w, vw - cx);
    const ch = Math.min(h, vh - cy);

    if (cw <= 0 || ch <= 0) return null;

    wc.width  = cw;
    wc.height = ch;
    ctx.drawImage(sv, cx, cy, cw, ch, 0, 0, cw, ch);

    return wc.toDataURL('image/jpeg', 0.88);
}

/* ===== 변화 감지 ===== */
function hasChanged() {
    if (!state.screenStream || !state.region) return false;

    const sv = state.screenVideoEl;
    const wc = state.workCanvas;
    const ctx = state.workCtx;
    const vw = sv.videoWidth;
    const vh = sv.videoHeight;
    if (!vw || !vh) return false;

    const { x, y, w, h } = state.region;
    const cx = Math.max(0, Math.min(x, vw - 1));
    const cy = Math.max(0, Math.min(y, vh - 1));
    const cw = Math.min(w, vw - cx);
    const ch = Math.min(h, vh - cy);
    if (cw <= 0 || ch <= 0) return false;

    // 섬네일 크기로 줄여 비교 (성능)
    const tw = Math.min(cw, 160);
    const th = Math.round(ch * (tw / cw));
    wc.width  = tw;
    wc.height = th;
    ctx.drawImage(sv, cx, cy, cw, ch, 0, 0, tw, th);

    const current = ctx.getImageData(0, 0, tw, th).data;

    if (!state.prevImageData || state.prevImageData.length !== current.length) {
        state.prevImageData = current.slice();
        return false;
    }

    const sensitivity = parseInt(sensitivityIn.value) || 5;
    const threshold   = sensitivity * 3; // 채널당 허용 차이
    let diffPixels = 0;
    const totalPixels = tw * th;

    for (let i = 0; i < current.length; i += 4) {
        const dr = Math.abs(current[i]   - state.prevImageData[i]);
        const dg = Math.abs(current[i+1] - state.prevImageData[i+1]);
        const db = Math.abs(current[i+2] - state.prevImageData[i+2]);
        if (dr > threshold || dg > threshold || db > threshold) diffPixels++;
    }

    const changeRatio = diffPixels / totalPixels;
    if (changeRatio > 0.02) { // 2% 이상 변화
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
        setStatus(`캡처됨 (총 ${state.captures.length}개)`, 'capturing');
    } else {
        setStatus('캡처 실패: 화면 공유 영상이 준비되지 않았습니다', 'warning');
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
    setStatus('자동 캡처 중... (변화 감지)', 'capturing');

    function tick() {
        if (!state.autoRunning) return;
        if (hasChanged()) {
            const dataUrl = captureRegion();
            if (dataUrl) {
                addCapture(dataUrl);
                setStatus(`변화 감지 → 캡처됨 (총 ${state.captures.length}개)`, 'capturing');
            }
        }
        state.autoTimer = setTimeout(tick, ms);
    }
    tick();
}

function stopAutoCapture() {
    state.autoRunning = false;
    clearTimeout(state.autoTimer);
    if (state.screenStream) {
        setStatus(`자동 캡처 중지됨 (총 ${state.captures.length}개 캡처됨)`, 'active');
    }
}

/* ===== 캡처 목록 추가 ===== */
function addCapture(dataUrl) {
    state.captureCount++;
    const id = state.captureCount;
    state.captures.push({ id, dataUrl });

    // 빈 힌트 제거
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
    del.title = '삭제';
    del.addEventListener('click', e => {
        e.stopPropagation();
        removeCapture(id, item);
    });

    label.appendChild(num);
    label.appendChild(del);
    item.appendChild(img);
    item.appendChild(label);
    captureList.appendChild(item);

    captureCountEl.textContent = state.captures.length;
    exportPdfBtn.disabled = false;

    // 자동 스크롤
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
            const img = await loadImage(state.captures[i].dataUrl);
            const iw  = img.naturalWidth  || img.width;
            const ih  = img.naturalHeight || img.height;
            const ratio = Math.min(pw / iw, ph / ih);
            const dw = iw * ratio;
            const dh = ih * ratio;
            const ox = (pw - dw) / 2;
            const oy = (ph - dh) / 2;
            pdf.addImage(state.captures[i].dataUrl, 'JPEG', ox, oy, dw, dh);
        }

        pdf.save(`youtube_capture_${Date.now()}.pdf`);
        setStatus(`PDF 저장됨 (${state.captures.length}페이지)`, 'active');
    } catch (err) {
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

/* ===== 창 리사이즈 시 오버레이 재조정 ===== */
window.addEventListener('resize', () => {
    // 구역이 있으면 오버레이 재설정은 간단히 초기화 (재선택 유도)
    if (state.region) {
        clearOverlay();
        state.region = null;
        state.prevImageData = null;
        setStatus('창 크기가 변경되었습니다. 구역을 다시 선택해주세요', 'warning');
    }
});
