// ===== helpers =====

async function getCookiesForUrl(url) {
    const cookies = await chrome.cookies.getAll({ url })
    return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function headersArrayToObject(headersArray) {
    const headers = {}
    for (const h of headersArray || []) {
        headers[h.name] = h.value
    }
    return headers
}

function isMasterPlaylist(url) {
    try {
        const path = new URL(url).pathname
        return /\.m3u8$/i.test(path) && !/\/ping\.m3u8$/i.test(path)
    } catch { return false }
}

function normalizePlaylistUrl(value) {
    const url = new URL(value)
    for (const name of ['_HLS_msn', '_HLS_part', '_HLS_skip']) url.searchParams.delete(name)
    url.hash = ''
    return url.toString()
}

const pendingStreams = new Set()
const observedSegments = new Set()

chrome.webRequest.onBeforeRequest.addListener(details => {
    const url = new URL(details.url)
    if (!/^media-hls\.doppiocdn\./i.test(url.hostname) || !/_\d+_[^_]+_\d+(?:_part\d+)?\.mp4$/.test(url.pathname)) return
    if (observedSegments.has(details.url)) return
    observedSegments.add(details.url)
    if (observedSegments.size > 2000) observedSegments.delete(observedSegments.values().next().value)
    fetch('http://localhost:3131/segment-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: details.url, extensionVersion: chrome.runtime.getManifest().version }), signal: AbortSignal.timeout(3000)
    }).then(response => {
        if (!response.ok) observedSegments.delete(details.url)
    }).catch(() => observedSegments.delete(details.url))
}, { urls: ['https://*.doppiocdn.media/*', 'https://*.doppiocdn.com/*', 'https://*.doppiocdn.net/*', 'https://*.doppiocdn.org/*'] })

const sentStreams = new Map()
const MAX_STREAMS_CACHE = 1000

// Cleanup old streams periodically to prevent memory leak
setInterval(() => {
    if (sentStreams.size > MAX_STREAMS_CACHE) {
        const arr = Array.from(sentStreams)
        sentStreams.clear()
        // Keep only recent 500 entries
        arr.slice(-500).forEach(([url, time]) => sentStreams.set(url, time))
    }
}, 5 * 60 * 1000) // Every 5 minutes

// ===== MAIN LISTENER =====

chrome.webRequest.onBeforeSendHeaders.addListener(
    async details => {
        // ловим ТОЛЬКО m3u8
        // if (!details.url.includes('.m3u8')) return
        if (!isMasterPlaylist(details.url)) return

        // 🔒 ДЕДУПЛИКАЦИЯ
        const url = normalizePlaylistUrl(details.url)
        const lastSent = sentStreams.get(url)
        if ((lastSent && Date.now() - lastSent < 30000) || pendingStreams.has(url)) return
        pendingStreams.add(url)

        try {

        // получаем вкладку
        const tab = details.tabId >= 0
            ? await chrome.tabs.get(details.tabId)
            : null

        const headers = headersArrayToObject(details.requestHeaders)

        const cookieHeader = await getCookiesForUrl(details.url)

        const payload = {
            url,
            extensionVersion: chrome.runtime.getManifest().version,
            headers: {
                ...headers,
                Cookie: cookieHeader,
                Referer: headers.Referer || headers.referer || tab?.url || ''
            }
        }

        try {
            const response = await fetch('http://localhost:3131/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(3000) // 3 second timeout
            })

            if (response.ok) {
                sentStreams.set(url, Date.now())
                console.log('🎯 HLS sent to Electron:', details.url)
            }
        } catch (err) {
            // Silent fail if Electron app is not running
            if (err.name !== 'AbortError' && !err.message.includes('Failed to fetch')) {
                console.error('❌ Failed to send HLS to Electron', err)
            }
        }
        } catch (err) {
            console.error('Failed to prepare HLS request', err)
        } finally {
            pendingStreams.delete(url)
        }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
)
