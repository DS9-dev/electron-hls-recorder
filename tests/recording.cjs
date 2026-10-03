const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const { patchPlaylist } = require('../hls')
const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hls-recorder-test-'))
const ffmpeg = path.resolve('bin/ffmpeg.exe')
const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', path.join(dir, 'input.m3u8')], { cwd: dir })
assert.equal(generated.status, 0, generated.stderr.toString())
let port
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    if (url.pathname === '/playlist-proxy') {
        let text = fs.readFileSync(path.join(dir, 'input.m3u8'), 'utf8')
        // Reproduce the site's real-URI tag followed by its dummy segment URL.
        text = text.replace(/^(input\d+\.m4s)$/gm, '#EXT-X-MOUFLON:URI:$1\nmedia.mp4')
        const result = patchPlaylist(text, `http://localhost:${port}/input.m3u8`, 'test').replaceAll('localhost:3131', `localhost:${port}`)
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        res.end(result)
    } else {
        const file = path.basename(new URL(url.searchParams.get('u')).pathname)
        res.setHeader('Content-Type', 'video/mp4')
        res.end(fs.readFileSync(path.join(dir, file)))
    }
})
server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data', '-allowed_extensions', 'ALL', '-i', `http://localhost:${port}/playlist-proxy`, '-c', 'copy', path.join(dir, 'result.mkv')])
    let stderr = ''
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill(), 15000)
    child.on('exit', code => {
        clearTimeout(timer)
        try {
            assert.equal(code, 0, stderr)
            assert.ok(fs.statSync(path.join(dir, 'result.mkv')).size > 1000)
            console.log('Passed: bundled FFmpeg records fragmented MP4 through the playlist and segment proxy')
            const stoppedFile = path.join(dir, 'stopped.mkv')
            const stopped = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data', '-allowed_extensions', 'ALL', '-i', `http://localhost:${port}/playlist-proxy`, '-c', 'copy', '-progress', 'pipe:1', stoppedFile])
            let requestedStop = false
            let errors = ''
            stopped.stderr.on('data', d => { errors += d })
            stopped.stdout.on('data', d => {
                const progress = /out_time_us=(\d+)/.exec(d.toString())
                if (progress && +progress[1] >= 1000000 && !requestedStop) {
                    requestedStop = true
                    stopped.stdin.write('q\n')
                }
            })
            const stopTimeout = setTimeout(() => stopped.kill(), 15000)
            stopped.on('exit', stopCode => {
                clearTimeout(stopTimeout)
                server.close()
                try {
                    assert.ok(requestedStop)
                    assert.equal(stopCode, 0, errors)
                    const probe = spawnSync(path.resolve('bin/ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', stoppedFile])
                    assert.equal(probe.status, 0, probe.stderr.toString())
                    assert.ok(+JSON.parse(probe.stdout).format.duration > 0)
                    console.log('Passed: STOP through stdin finalizes a readable MKV and exits normally')
                } catch (err) { console.error(err); process.exitCode = 1 }
            })
        } catch (err) { server.close(); console.error(err); process.exitCode = 1 }
    })
})
