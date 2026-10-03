const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const source = process.argv[2]
const url = `http://localhost:3131/playlist-proxy?u=${encodeURIComponent(source)}&s=${encodeURIComponent(source)}`
const output = path.join(__dirname, 'live-check.mkv')
const result = spawnSync(path.resolve('bin/ffmpeg.exe'), ['-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data', '-allowed_extensions', 'ALL', '-i', url, '-t', '6', '-c', 'copy', output], { timeout: 20000 })
console.log('Recording exit:', result.status)
console.log(result.stderr?.toString().slice(-2000))
if (fs.existsSync(output)) {
    console.log('File bytes:', fs.statSync(output).size)
    const probe = spawnSync(path.resolve('bin/ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', output])
    console.log(probe.stdout.toString())
    fs.unlinkSync(output)
}
