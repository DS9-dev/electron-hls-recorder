const { app, BrowserWindow, ipcMain, dialog } = require('electron')
if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
}
const { execa } = require('execa')
const express = require('express')
const fetch = global.fetch || require('node-fetch')
const { URL } = require('url')
const fs = require('fs')
const path = require('path')
const { streamGroup } = require('./stream-groups')
const { normalizePlaylistUrl, patchPlaylist, requestHeaders, segmentIdentity, resolveObservedSegment, activePlaylistUrl } = require('./hls')
const observedSegments = new Map()
const RECORDER_VERSION = '1.0.7-tile-layout'
let lastSegmentAt = null
let extensionVersion = null

// ========================
// STATE
// ========================

let win = null
app.on('second-instance', () => {
    if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
    }
})

// все обнаруженные стримы
const discoveredStreams = new Map()
// url -> { url, headers, status, output, aes, resolvedUrl, playlistPath }

// активные ffmpeg процессы
const recorders = new Map()
// url -> { process, output }

// ========================
// WINDOW
// ========================

function createWindow() {
    win = new BrowserWindow({
        width: 1100,
        height: 780,
        minWidth: 640,
        minHeight: 440,
        frame: false,
        backgroundColor: '#111318',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    })
    win.removeMenu()

    win.loadFile('index.html')
    win.webContents.on('did-finish-load', () => {
        win.setTitle(`HLS Recorder ${RECORDER_VERSION}`)
        send('recorder:log', `Версия приложения: ${RECORDER_VERSION}`)
    })
}

// ========================
// HELPERS
// ========================

function send(channel, payload) {
    if (channel === 'recorder:log' || channel === 'recorder:error') {
        try {
            const message = typeof payload === 'string' ? payload : payload.message
            fs.appendFileSync(path.join(app.getPath('userData'), 'recorder.log'), `${new Date().toISOString()} ${message}\n`)
        } catch { /* Logging must not stop recording. */ }
    }
    if (win && win.webContents) {
        win.webContents.send(channel, payload)
    }
}

function safeFilename(url) {
    let baseName = null
    
    // Try to extract name from URL: stream_<name>
    const streamMatch = url.match(/stream_([^\/\?]+)/)
    if (streamMatch && streamMatch[1]) {
        // Clean the name: remove special characters, keep only alphanumeric and underscore
        baseName = streamMatch[1].replace(/[^a-zA-Z0-9_]/g, '_')
        // Limit length
        if (baseName.length > 50) {
            baseName = baseName.slice(0, 50)
        }
    }
    
    // If no name extracted, use random name
    if (!baseName) {
        baseName = 'record_' + Buffer.from(url).toString('base64').slice(0, 24)
    }
    
    const downloadsDir = app.getPath('downloads')
    let filename = `${baseName}.mkv`
    let filePath = path.join(downloadsDir, filename)
    let counter = 1
    
    // Check if file exists and add counter if needed
    while (fs.existsSync(filePath)) {
        filename = `${baseName}_${counter}.mkv`
        filePath = path.join(downloadsDir, filename)
        counter++
    }
    
    return filePath
}

// ========================
// PLAYLIST ANALYZE + PATCH
// ========================

async function analyzeAndPatchPlaylist(stream) {
    const { resolvedUrl, headers } = stream

    send('recorder:log', `🔍 loading playlist`)
    const res = await fetch(resolvedUrl, { headers })

    if (!res.ok) {
        throw new Error(`playlist fetch failed (${res.status})`)
    }

    let text = await res.text()
    if (/doppiocdn\./i.test(new URL(resolvedUrl).hostname) && /\/cpa\//.test(text)) {
        throw new Error('CDN вернул рекламный ролик. Выберите поток media-hls с параметрами psch и pkey.')
    }
    if (text.includes('#EXT-X-MOUFLON:PSCH:')) {
        const firstUri = text.match(/^#EXT-X-MOUFLON:URI:(.+\.mp4)\s*$/m)
        const segment = firstUri && segmentIdentity(firstUri[1].trim())
        const qualityPrefix = segment?.prefix.replace(/_\d+$/, '')
        const browserIsWatching = qualityPrefix && [...observedSegments.values()].some(value =>
            value.prefix.replace(/_\d+$/, '') === qualityPrefix && Date.now() - value.receivedAt < 15000)
        if (!browserIsWatching) {
            throw new Error('Нет свежих адресов сегментов для этого качества. Обновите расширение, откройте трансляцию в браузере и выберите в приложении поток того же качества. Подождите 5 секунд и повторите START.')
        }
    }

    // AES-128 detection
    const keyMatch = text.match(
        /#EXT-X-KEY:METHOD=AES-128,([^\n]+)/
    )

    if (keyMatch) {
        const attrs = Object.fromEntries(
            keyMatch[1]
                .split(',')
                .map(p => p.split('=').map(v => v.replace(/"/g, '')))
        )

        const keyUri = new URL(attrs.URI, resolvedUrl).toString()

        stream.aes = {
            method: 'AES-128',
            uri: keyUri,
            iv: attrs.IV || null
        }

        send('recorder:log', `🔐 AES-128 detected`)
        send('recorder:log', `   KEY: ${keyUri}`)
        send('recorder:log', `🔁 KEY patched → proxy`)
    } else {
        send('recorder:log', `🔓 no AES detected`)
    }

    send('recorder:log', `🔗 segment URLs patched → proxy`)

    // Use proxy URL instead of local file
    stream.playlistPath = `http://localhost:3131/playlist-proxy?u=${encodeURIComponent(resolvedUrl)}&s=${encodeURIComponent(stream.url)}`

    send('recorder:log', `📄 using live playlist proxy`)
}

// ========================
// BEST VARIANT
// ========================

async function resolveBestVariant(masterUrl, headers = {}) {
    const res = await fetch(masterUrl, { headers })
    if (!res.ok) throw new Error(`playlist load failed (HTTP ${res.status})`)

    const text = await res.text()
    if (!text.includes('#EXT-X-STREAM-INF')) return masterUrl

    const base = new URL(masterUrl)
    const lines = text.split('\n')
    const variants = []

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue

        const info = lines[i]
        const urlLine = lines[i + 1]
        if (!urlLine || urlLine.startsWith('#')) continue

        const bw = /BANDWIDTH=(\d+)/.exec(info)
        const reso = /RESOLUTION=(\d+)x(\d+)/.exec(info)

        variants.push({
            bandwidth: bw ? +bw[1] : 0,
            pixels: reso ? +reso[1] * +reso[2] : 0,
            url: new URL(urlLine, base).toString()
        })
    }

    variants.sort(
        (a, b) =>
            b.bandwidth - a.bandwidth ||
            b.pixels - a.pixels
    )

    return variants[0]?.url || masterUrl
}

// ========================
// THUMBNAIL EXTRACTION
// ========================

async function extractThumbnail(stream) {
    if (stream.thumbnailPath) return stream.thumbnailPath

    // Use playlistPath if available, otherwise use resolvedUrl or original url
    let input = stream.playlistPath
    if (!input) {
        if (stream.resolvedUrl) {
            input = stream.resolvedUrl
        } else {
            input = stream.url
        }
    }

    const thumbnailPath = path.join(
        app.getPath('temp'),
        `thumb_${Date.now()}_${Buffer.from(stream.url).toString('base64').slice(0, 12)}.jpg`
    )

    try {
        const args = [
            '-y',
            '-loglevel', 'error',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
            '-allowed_extensions', 'ALL',
            '-i', input,
            '-vframes', '1',
            '-q:v', '2',
            '-vf', 'scale=320:-1',
            thumbnailPath
        ]

        await execa(app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg.exe') : path.join(__dirname, 'bin', 'ffmpeg.exe'), args, { timeout: 10000 })
        
        if (fs.existsSync(thumbnailPath)) {
            stream.thumbnailPath = thumbnailPath
            send('stream:thumbnail', { url: stream.url, thumbnailPath })
            return thumbnailPath
        }
    } catch (err) {
        // Silent fail - thumbnail is optional
    }
    
    return null
}

// ========================
// RECORDER CORE
// ========================

function startRecorder(stream) {
    const input = stream.playlistPath
    const output = safeFilename(stream.resolvedUrl)

    stream.status = 'recording'
    stream.output = output

    const args = [
        '-y',
        '-loglevel', 'info',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
        '-allowed_extensions', 'ALL',

        '-i', input,

        '-c', 'copy',
        '-fflags', '+genpts',
        '-avoid_negative_ts', 'make_zero',

        '-progress', 'pipe:1',
        '-nostats',

        output
    ]
    const ffmpegPath = app.isPackaged
        ? path.join(process.resourcesPath, 'ffmpeg.exe')
        : path.join(__dirname, 'bin', 'ffmpeg.exe')

    const ffmpeg = execa(ffmpegPath, args, { stdin: 'pipe' })
    const recorder = { process: ffmpeg, output, stopping: false, stopTimer: null }
    recorders.set(stream.url, recorder)

    send('recorder:started', { url: stream.url, output })

    ffmpeg.stdout.on('data', d => {
        const p = { url: stream.url }
        d.toString().split('\n').forEach(l => {
            const [k, v] = l.split('=')
            if (k === 'out_time_ms') p.time = Math.floor(v / 1e6)
            if (k === 'total_size') p.size = +v
            if (k === 'speed') p.speed = v
        })
        if (Object.keys(p).length > 1)
            send('recorder:progress', p)
    })

    ffmpeg.stderr.on('data', d =>
        send('recorder:log', d.toString())
    )

    ffmpeg.on('exit', code => {
        clearTimeout(recorder.stopTimer)
        recorders.delete(stream.url)
        stream.status = 'stopped'
        send('recorder:stopped', { url: stream.url, code })
    })

    ffmpeg.catch(err => {
        if (recorder.stopping && err.signal === 'SIGINT') return
        send('recorder:error', {
            url: stream.url,
            message: err.message
        })
    })
}

// ========================
// IPC (UI)
// ========================

ipcMain.handle('streams:list', () => [...discoveredStreams.values()].map(stream => ({
    url: stream.url, label: stream.label, status: stream.status, output: stream.output,
    thumbnailPath: stream.thumbnailPath
})))

ipcMain.on('window:control', (event, action) => {
    if (!win || event.sender !== win.webContents) return
    if (action === 'close') win.close()
    if (action === 'minimize') win.minimize()
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
})

ipcMain.on('recorder:start', async (_, { url }) => {
    const stream = discoveredStreams.get(url)
    if (!stream) return
    
    // Allow restart from 'stopped' or 'idle' state
    if (['recording', 'starting', 'stopping'].includes(stream.status)) return

    try {
        // Reset status for restart
        stream.status = 'starting'
        
        const activeUrl = activePlaylistUrl(stream.sourceUrl || stream.url, observedSegments)
        if (activeUrl !== stream.url) send('recorder:log', `Качество изменилось в браузере. Записываем: ${new URL(activeUrl).pathname}`)
        stream.resolvedUrl = await resolveBestVariant(
            activeUrl,
            stream.headers
        )

        await analyzeAndPatchPlaylist(stream)
        
        // Extract thumbnail in background (don't wait)
        extractThumbnail(stream).catch(() => {})
        
        startRecorder(stream)
    } catch (err) {
        stream.status = 'stopped'
        send('recorder:error', {
            url,
            message: err.message
        })
    }
})

ipcMain.on('recorder:stop', (_, { url }) => {
    const r = recorders.get(url)
    if (r && !r.stopping) {
        r.stopping = true
        discoveredStreams.get(url).status = 'stopping'
        r.process.stdin.write('q\n', () => {})
        r.stopTimer = setTimeout(() => r.process.kill('SIGINT'), 5000)
    }
})

ipcMain.on('stream:remove', (_, { url }) => {
    const stream = discoveredStreams.get(url)
    if (!stream) return
    
    // Don't remove if recording
    if (['recording', 'starting', 'stopping'].includes(stream.status)) return
    
    discoveredStreams.delete(url)
    send('stream:removed', { url })
})

// ========================
// API (Chrome Extension)
// ========================

const api = express()
api.use(express.json({ limit: '2mb' }))

api.get('/status', (_, res) => res.json({
    version: RECORDER_VERSION, extensionVersion,
    streamCount: discoveredStreams.size,
    observedSegments: observedSegments.size, lastSegmentAt
}))

api.post('/segment-url', (req, res) => {
    let segment
    try { segment = segmentIdentity(req.body.url) } catch { return res.status(400).end() }
    if (!segment || !/^media-hls\.doppiocdn\./i.test(segment.url.hostname)) return res.status(400).end()
    observedSegments.set(segment.key, segment)
    segment.receivedAt = Date.now()
    lastSegmentAt = new Date().toISOString()
    extensionVersion = req.body.extensionVersion || 'unknown'
    if (observedSegments.size === 1) send('recorder:log', `Расширение ${extensionVersion}: получен реальный адрес сегмента из браузера`)
    while (observedSegments.size > 2000) observedSegments.delete(observedSegments.keys().next().value)
    res.json({ ok: true })
})

api.post('/record', async (req, res) => {
    const headers = requestHeaders(req.body.headers)
    extensionVersion = req.body.extensionVersion || 'unknown'
    let url
    try { url = normalizePlaylistUrl(req.body.url) } catch { return res.status(400).json({ ok: false }) }
    if (!url) return res.status(400).json({ ok: false })

    const group = streamGroup(url)
    if (group.hidden) return res.json({ ok: true, hidden: true })
    const existing = [...discoveredStreams.values()].find(stream => stream.groupId === group.id)
    if (existing) {
        if (group.rank >= existing.sourceRank) {
            existing.sourceUrl = url
            existing.sourceRank = group.rank
            existing.headers = headers
        }
        return res.json({ ok: true, duplicate: true })
    }

    if (discoveredStreams.has(url)) {
        discoveredStreams.get(url).headers = headers
        return res.json({ ok: true, duplicate: true })
    }

    const stream = {
        url,
        sourceUrl: url,
        groupId: group.id,
        sourceRank: group.rank,
        label: group.label,
        headers,
        status: 'idle'
    }
    
    discoveredStreams.set(url, stream)

    send('stream:discovered', { url, label: stream.label })
    res.json({ ok: true })

    // Extract thumbnail in background
    ;(async () => {
        try {
            // Get best variant first
            stream.resolvedUrl = await resolveBestVariant(stream.sourceUrl, stream.headers)
            // Try to extract thumbnail
            await analyzeAndPatchPlaylist(stream)
            await extractThumbnail(stream)
        } catch (err) {
            // Silent fail - thumbnail is optional
        }
    })()
})

// 🔐 KEY PROXY
api.get('/key-proxy', async (req, res) => {
    const keyUrl = req.query.u
    const streamUrl = req.query.s
    if (!keyUrl) return res.status(400).end()

    const stream = streamUrl 
        ? discoveredStreams.get(streamUrl)
        : [...discoveredStreams.values()].find(s => s.aes?.uri === keyUrl)

    if (!stream) return res.status(404).end()

    try {
        const r = await fetch(keyUrl, {
            headers: stream.headers
        })

        if (!r.ok) return res.status(403).end()

        const buf = Buffer.from(await r.arrayBuffer())
        res.setHeader('Content-Type', 'application/octet-stream')
        res.end(buf)
    } catch {
        res.status(500).end()
    }
})

// 📋 PLAYLIST PROXY
api.get('/playlist-proxy', async (req, res) => {
    const playlistUrl = req.query.u
    const streamUrl = req.query.s
    if (!playlistUrl || !streamUrl) return res.status(400).end()

    const stream = discoveredStreams.get(streamUrl)
    if (!stream) return res.status(404).end()

    try {
        const r = await fetch(playlistUrl, {
            headers: stream.headers
        })

        if (!r.ok) return res.status(r.status).end()

        let text = await r.text()
        text = patchPlaylist(text, playlistUrl, streamUrl, observedSegments)

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(text)
    } catch (err) {
        res.status(500).end()
    }
})

// 📦 SEGMENT PROXY
api.get(['/segment-proxy.ts', '/segment-proxy.mp4'], async (req, res) => {
    const segmentUrl = req.query.u
    const streamUrl = req.query.s
    if (!segmentUrl || !streamUrl) return res.status(400).end()

    const stream = discoveredStreams.get(streamUrl)
    if (!stream) return res.status(404).end()

    try {
        let upstreamUrl = segmentUrl
        if (segmentIdentity(segmentUrl) && !observedSegments.has(segmentIdentity(segmentUrl).key)) {
            for (let attempt = 0; attempt < 30; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100))
                if (observedSegments.has(segmentIdentity(segmentUrl).key)) break
            }
        }
        upstreamUrl = resolveObservedSegment(upstreamUrl, observedSegments)
        const r = await fetch(upstreamUrl, {
            headers: { ...stream.headers, ...(req.headers.range ? { range: req.headers.range } : {}) }
        })

        if (!r.ok) return res.status(r.status).end()

        const buf = Buffer.from(await r.arrayBuffer())
        res.status(r.status)
        for (const name of ['content-range', 'accept-ranges']) {
            const value = r.headers.get(name)
            if (value) res.setHeader(name, value)
        }
        res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(buf)
    } catch (err) {
        res.status(500).end()
    }
})

const apiServer = api.listen(3131, () =>
    console.log('Electron API listening on http://localhost:3131')
)
apiServer.on('error', error => {
    dialog.showErrorBox('HLS Recorder: API недоступен', error.code === 'EADDRINUSE'
        ? 'Порт 3131 занят другим экземпляром приложения. Закройте все окна HLS Recorder и запустите приложение снова.'
        : error.message)
    app.quit()
})

// ========================
// APP
// ========================

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
    apiServer.close()
    for (const recorder of recorders.values()) recorder.process.kill('SIGINT')
})
