// Vercel 서버리스 함수: Piped API 프록시
// 브라우저→Piped는 CORS 차단, 서버→Piped는 제한 없음
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://piped-api.garudalinux.org',
    'https://api.piped.yt',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.in.projectsegfau.lt',
];

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { videoId } = req.query;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'videoId 파라미터 필요 (11자리)' });
    }

    const errors = [];
    for (const base of PIPED_INSTANCES) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const r = await fetch(`${base}/streams/${videoId}`, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            clearTimeout(timer);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            return res.status(200).json(data);
        } catch (e) {
            errors.push(`${base}: ${e.message}`);
        }
    }

    return res.status(502).json({
        error: '모든 Piped 인스턴스 실패',
        details: errors,
    });
};
