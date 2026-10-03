const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { normalizePlaylistUrl, patchPlaylist, requestHeaders, segmentIdentity, resolveObservedSegment, activePlaylistUrl } = require('../hls')
const actual = segmentIdentity('https://media-hls.doppiocdn.media/b-hls-16/263141605/263141605_4724_6HJUXb8zNGPwB29t_1791035847_part0.mp4')
const observed = new Map([[actual.key, actual]])
actual.receivedAt = 10000
assert.equal(new URL(activePlaylistUrl('https://media-hls.doppiocdn.media/b-hls-16/263141605/263141605_240p.m3u8?pkey=test', observed, 11000)).pathname, '/b-hls-16/263141605/263141605.m3u8')
assert.throws(() => activePlaylistUrl('https://media-hls.doppiocdn.media/b-hls-16/263141605/263141605.m3u8', observed, 30000), /свежие сегменты/)
assert.equal(resolveObservedSegment('https://media-hls.doppiocdn.media/b-hls-16/263141605/263141605_4724_encrypted+token/abc_1791035847.mp4', observed), 'https://media-hls.doppiocdn.media/b-hls-16/263141605/263141605_4724_6HJUXb8zNGPwB29t_1791035847.mp4')
assert.equal(resolveObservedSegment('https://media-hls.doppiocdn.media/b-hls-16/263141605/263141605_4725_other_1791035849.mp4', observed), 'https://media-hls.doppiocdn.media/b-hls-16/263141605/263141605_4725_other_1791035849.mp4')
assert.deepEqual(requestHeaders({ referer: 'https://site.test/', Referer: 'https://site.test/', Origin: 'https://site.test', 'Accept-Encoding': 'zstd', Host: 'cdn.test' }), { referer: 'https://site.test/', origin: 'https://site.test' })
const base = 'https://cdn.test/live/123.m3u8?pkey=test&_HLS_msn=42&_HLS_part=2'
assert.equal(normalizePlaylistUrl(base), 'https://cdn.test/live/123.m3u8?pkey=test')
const fixture = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXT-X-MOUFLON:URI:https://cdn.test/live/part.mp4
#EXT-X-PART:DURATION=0.5,URI="media.mp4"
#EXTINF:2,
#EXT-X-MOUFLON:URI:https://cdn.test/live/complete.mp4
media.mp4`
const patched = patchPlaylist(fixture, base, base)
assert.ok(!patched.includes('#EXT-X-MOUFLON:'))
assert.ok(!patched.includes('#EXT-X-PART:'))
const map = patched.match(/#EXT-X-MAP:URI="([^"]+)"/)[1]
assert.equal(new URL(map).pathname, '/segment-proxy.mp4')
const segments = patched.split('\n').filter(line => line && !line.startsWith('#'))
assert.ok(segments.length)
for (const line of segments) {
    const url = new URL(line)
    assert.equal(url.hostname, 'localhost')
    assert.equal(url.pathname, '/segment-proxy.mp4')
    assert.ok(!new URL(url.searchParams.get('u')).pathname.endsWith('/media.mp4'))
    assert.ok(!url.searchParams.get('u').includes('_part'))
}
const aes = patchPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key?x=a=b",IV=0x01\n#EXTINF:2,\na.ts', base, base)
assert.ok(aes.includes('METHOD=AES-128'))
assert.ok(aes.includes('IV=0x01'))
assert.ok(aes.includes('/key-proxy?'))
const protectedPlaylist = patchPlaylist('#EXTM3U\n#EXT-X-MOUFLON:PSCH:v2:test-key\n#EXTINF:2,\n#EXT-X-MOUFLON:URI:https://cdn.test/live/complete.mp4\nmedia.mp4', base, base)
const media = new URL(new URL(protectedPlaylist.split('\n').at(-1)).searchParams.get('u'))
assert.equal(media.searchParams.get('psch'), 'v2')
assert.equal(media.searchParams.get('pkey'), 'test-key')
let listener
let segmentListener
let observedPayload
let sends = 0
let success = false
const context = {
    URL, AbortSignal, console, setInterval() {},
    fetch: async (url, options) => {
        if (url.endsWith('/segment-url')) { observedPayload = JSON.parse(options.body); return { ok: true } }
        sends++; return { ok: success }
    },
    chrome: {
        runtime: { getManifest: () => ({ version: '0.2.1' }) },
        cookies: { getAll: async () => [] },
        tabs: { get: async () => ({ url: 'https://site.test/' }) },
        webRequest: { onBeforeRequest: { addListener: fn => { segmentListener = fn } }, onBeforeSendHeaders: { addListener: fn => { listener = fn } } }
    }
}
vm.createContext(context)
vm.runInContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8'), context)
async function checkDelivery() {
    segmentListener({ url: actual.url.toString() })
    assert.equal(observedPayload.url, actual.url.toString())
    await listener({ url: 'https://cdn.test/ping.m3u8', tabId: 1 })
    assert.equal(sends, 0)
    await listener({ url: base, tabId: 1 })
    assert.equal(sends, 1)
    success = true
    await listener({ url: base, tabId: 1 })
    assert.equal(sends, 2, 'failed delivery must retry')
    await listener({ url: base.replace('msn=42', 'msn=43'), tabId: 1 })
    assert.equal(sends, 2, 'blocking reload must not create another stream')
    console.log(`Passed: playlist rewriting (${segments.length} complete segments), AES, detection, retries and deduplication`)
}
checkDelivery().catch(err => { console.error(err); process.exitCode = 1 })
