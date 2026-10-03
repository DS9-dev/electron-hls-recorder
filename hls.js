// Keep blocking-reload cursors out of the URL used by the recorder.
function normalizePlaylistUrl(value) {
    const url = new URL(value)
    for (const name of ['_HLS_msn', '_HLS_part', '_HLS_skip']) url.searchParams.delete(name)
    url.hash = ''
    return url.toString()
}

function requestHeaders(input = {}) {
    const headers = {}
    for (const [name, value] of Object.entries(input)) {
        const lower = name.toLowerCase()
        if (name.startsWith(':') || ['host', 'connection', 'content-length', 'accept-encoding', 'range'].includes(lower)) continue
        if (typeof value === 'string') headers[lower] = value
    }
    return headers
}

function segmentIdentity(value) {
    const url = new URL(value)
    const match = url.pathname.match(/^(.*_\d+)_([^_]+)_(\d+)(_part\d+)?\.mp4$/)
    return match ? { key: `${url.origin}${match[1]}_${match[3]}`, prefix: match[1], token: match[2], timestamp: match[3], part: match[4] || '', url } : null
}

function resolveObservedSegment(value, observed) {
    const segment = segmentIdentity(value)
    if (!segment) return value
    const actual = observed.get(segment.key)
    if (!actual) return value
    const result = new URL(actual.url.toString())
    result.pathname = `${actual.prefix}_${actual.token}_${actual.timestamp}${segment.part}.mp4`
    return result.toString()
}

function activePlaylistUrl(value, observed, now = Date.now()) {
    const source = new URL(value)
    if (!/^media-hls\.doppiocdn\./i.test(source.hostname)) return value
    const match = source.pathname.match(/^(.*\/)(\d+)(?:_\d+p)?\.m3u8$/)
    if (!match) return value
    const candidates = [...observed.values()].filter(segment =>
        segment.url.origin === source.origin && segment.prefix.startsWith(`${match[1]}${match[2]}_`) &&
        now - segment.receivedAt < 15000)
    candidates.sort((a, b) => b.receivedAt - a.receivedAt)
    if (!candidates.length) throw new Error('Браузер не передаёт свежие сегменты этой трансляции. Оставьте видео воспроизводиться и повторите START через 5 секунд.')
    source.pathname = candidates[0].prefix.replace(/_\d+$/, '').replace(/_h264$/, '') + '.m3u8'
    return source.toString()
}

function patchPlaylist(text, resolvedUrl, streamUrl, observed = new Map()) {
    const base = new URL(resolvedUrl)
    const mouflon = text.match(/^#EXT-X-MOUFLON:PSCH:([^:\r\n]+):([^\r\n]+)/m)
    const proxy = (uri, route) => {
        const original = new URL(uri, resolvedUrl).toString()
        const resolved = resolveObservedSegment(original, observed)
        const target = new URL(resolved)
        // The CDN needs the scheme and key identifier on media requests too.
        if (resolved === original && mouflon && target.origin === base.origin) {
            if (!target.searchParams.has('psch')) target.searchParams.set('psch', mouflon[1])
            if (!target.searchParams.has('pkey')) target.searchParams.set('pkey', mouflon[2])
        }
        const absolute = target.toString()
        return `http://localhost:3131/${route}?u=${encodeURIComponent(absolute)}&s=${encodeURIComponent(streamUrl)}`
    }
    let pendingUri = null
    return text.split(/\r?\n/).flatMap(raw => {
        const line = raw.trim()
        if (line.startsWith('#EXT-X-MOUFLON:URI:')) {
            pendingUri = line.slice('#EXT-X-MOUFLON:URI:'.length)
            return []
        }
        if (line.startsWith('#EXT-X-MOUFLON:')) return []
        // FFmpeg records completed segments; partial segments would duplicate them.
        if (/^#EXT-X-(PART:|PRELOAD-HINT:)/.test(line)) {
            pendingUri = null
            return []
        }
        if (/^#EXT-X-(PART-INF:|SERVER-CONTROL:|RENDITION-REPORT:)/.test(line)) return []
        if (!line || line.startsWith('#')) {
            const route = /^#EXT-X-(KEY|SESSION-KEY):/.test(line) ? 'key-proxy' :
                /^#EXT-X-MAP:/.test(line) ? 'segment-proxy.mp4' : 'playlist-proxy'
            return [line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxy(uri, route)}"`)]
        }
        const uri = pendingUri || line
        pendingUri = null
        const pathname = new URL(uri, resolvedUrl).pathname
        const route = /\.m3u8$/i.test(pathname) ? 'playlist-proxy' :
            /\.(mp4|m4s)$/i.test(pathname) ? 'segment-proxy.mp4' : 'segment-proxy.ts'
        return [proxy(uri, route)]
    }).join('\n')
}

module.exports = { normalizePlaylistUrl, patchPlaylist, requestHeaders, segmentIdentity, resolveObservedSegment, activePlaylistUrl }
