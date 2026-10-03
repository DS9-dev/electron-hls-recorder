function streamGroup(value) {
    const url = new URL(value)
    if (/^(edge|media)-hls\.doppiocdn\./i.test(url.hostname)) {
        if (/\/master\//.test(url.pathname) || /\/ping\.m3u8$/.test(url.pathname)) return { hidden: true }
        const match = url.pathname.match(/\/([0-9]+)\/(?:\1)(?:_\d+p)?\.m3u8$/)
        if (match) return { id: `stripchat:${match[1]}`, rank: 1, label: `Stripchat · ${match[1]} · Качество браузера` }
    }
    if (/(^|\.)bcvcdn\.com$/i.test(url.hostname)) {
        const match = url.pathname.match(/^\/hls\/stream_([^/]+)\//)
        if (match) return {
            id: `bcvcdn:${match[1]}`,
            rank: /\/playlist\.m3u8$/i.test(url.pathname) ? 3 : /_\d+\/chunks\.m3u8$/i.test(url.pathname) ? 1 : 2,
            label: `${match[1]} · Лучшее доступное качество`
        }
    }
    return { id: value, rank: 1, label: value }
}

module.exports = { streamGroup }
