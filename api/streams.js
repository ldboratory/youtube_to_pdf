// Vercel 서버리스 함수: Piped/Invidious API 프록시 (병렬 요청)
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://piped-api.garudalinux.org',
    'https://api.piped.yt',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.in.projectsegfau.lt',
    'https://piapi.ggtyler.dev',
];

const INVIDIOUS_INSTANCES = [
    'https://yewtu.be',
    'https://inv.riverside.rocks',
    'https://invidious.kavin.rocks',
    'https://invidious.projectsegfau.lt',
    'https://invidious.nerdvpn.de',
];

async function tryFetch(url, ms = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const r = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        clearTimeout(timer);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// 여러 URL을 병렬로 시도, 가장 먼저 성공한 것 반환
async function raceRequests(urlFns, transform) {
    return new Promise((resolve, reject) => {
        let failed = 0;
        const total = urlFns.length;
        const errors = [];

        urlFns.forEach(({ url, id }) => {
            tryFetch(url)
                .then(data => {
                    const result = transform(data, id);
                    if (result) resolve(result);
                    else throw new Error('변환 실패');
                })
                .catch(e => {
                    errors.push(`${id}: ${e.message}`);
                    failed++;
                    if (failed === total) reject(new Error(errors.join(' | ')));
                });
        });
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { videoId } = req.query;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'videoId 파라미터 필요 (11자리)' });
    }

    // Piped 병렬 요청
    try {
        const result = await raceRequests(
            PIPED_INSTANCES.map(base => ({ url: `${base}/streams/${videoId}`, id: base })),
            (data, id) => {
                if (!data.hls && !data.videoStreams?.length) return null;
                return { ...data, _source: 'piped', _instance: id };
            }
        );
        return res.status(200).json(result);
    } catch (pipedErr) {
        // Piped 전부 실패 → Invidious 병렬 요청
        try {
            const result = await raceRequests(
                INVIDIOUS_INSTANCES.map(base => ({ url: `${base}/api/v1/videos/${videoId}`, id: base })),
                (data, id) => {
                    const videoStreams = (data.adaptiveFormats || [])
                        .filter(f => f.type?.includes('video/mp4'))
                        .map(f => ({ url: f.url, mimeType: f.type, quality: f.qualityLabel || '' }));
                    if (!data.hlsUrl && !videoStreams.length) return null;
                    return { hls: data.hlsUrl || null, videoStreams, _source: 'invidious', _instance: id };
                }
            );
            return res.status(200).json(result);
        } catch (invidiousErr) {
            return res.status(502).json({
                error: '모든 인스턴스 실패',
                piped: pipedErr.message,
                invidious: invidiousErr.message,
            });
        }
    }
};
