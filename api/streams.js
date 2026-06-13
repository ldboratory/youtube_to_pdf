// Vercel 서버리스 함수: Piped/Invidious API 프록시
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://piped-api.garudalinux.org',
    'https://api.piped.yt',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.in.projectsegfau.lt',
    'https://piapi.ggtyler.dev',
    'https://pipedapi.moomoo.me',
    'https://eu.piped.stream/api',
];

const INVIDIOUS_INSTANCES = [
    'https://yewtu.be',
    'https://invidious.snopyta.org',
    'https://inv.riverside.rocks',
    'https://invidious.kavin.rocks',
    'https://vid.puffyan.us',
    'https://invidious.nerdvpn.de',
    'https://invidious.projectsegfau.lt',
];

async function fetchWithTimeout(url, ms = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const r = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        clearTimeout(timer);
        return r;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { videoId } = req.query;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'videoId 파라미터 필요 (11자리)' });
    }

    const errors = [];

    // 1단계: Piped 인스턴스 시도
    for (const base of PIPED_INSTANCES) {
        try {
            const r = await fetchWithTimeout(`${base}/streams/${videoId}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            if (data.hls || data.videoStreams?.length) {
                return res.status(200).json({ ...data, _source: 'piped' });
            }
            throw new Error('스트림 없음');
        } catch (e) {
            errors.push(`piped:${base}: ${e.message}`);
        }
    }

    // 2단계: Invidious 인스턴스 시도 (응답을 Piped 형식으로 변환)
    for (const base of INVIDIOUS_INSTANCES) {
        try {
            const r = await fetchWithTimeout(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats,hlsUrl`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();

            // Invidious → Piped 형식으로 변환
            const videoStreams = (data.adaptiveFormats || [])
                .filter(f => f.type?.includes('video/mp4'))
                .map(f => ({
                    url: f.url,
                    mimeType: f.type,
                    quality: f.qualityLabel || f.resolution || '',
                }));

            return res.status(200).json({
                hls: data.hlsUrl || null,
                videoStreams,
                _source: 'invidious',
                _instance: base,
            });
        } catch (e) {
            errors.push(`invidious:${base}: ${e.message}`);
        }
    }

    return res.status(502).json({
        error: '모든 인스턴스 실패 (Piped + Invidious)',
        details: errors,
    });
};
