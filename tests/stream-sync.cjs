const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const routes = new Map()
const handlers = new Map()
const events = new Map()
let fetchedUrl
const api = {
    use() {}, post: (name, fn) => routes.set(name, fn), get() {},
    listen: () => ({ on() {} })
}
const express = () => api
express.json = () => () => {}
const localRequire = require('node:module').createRequire(path.resolve('main.js'))
const context = {
    __dirname: path.resolve('.'), console, URL, Buffer, process, setTimeout,
    fetch: url => { fetchedUrl = url; return new Promise(() => {}) },
    require: name => {
        if (name === 'electron') return {
            app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
            ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => events.set(name, fn) }
        }
        if (name === 'express') return express
        return localRequire(name)
    }
}
context.global = context
vm.runInNewContext(`(function(require) { ${fs.readFileSync('main.js', 'utf8')} })(require)`, context)
const record = routes.get('/record')
const request = { body: { url: 'https://cdn.test/live.m3u8?_HLS_msn=1', headers: {} } }
let response
const res = { json: value => { response = value } }
async function test() {
    // No BrowserWindow exists yet: the initial discovery event cannot be delivered.
    await record(request, res)
    assert.equal(response.ok, true)
    assert.equal(handlers.get('streams:list')().length, 1)
    const root = 'https://live-edge38-rn.bcvcdn.com/hls/stream_MaoandLulu/'
    const variant = root + 'public-aac/stream_MaoandLulu_240/chunks.m3u8'
    await record({ body: { url: variant, headers: {} } }, res)
    await record({ body: { url: root + 'playlist.m3u8', headers: {} } }, res)
    await record({ body: { url: root + 'public-aac/stream_MaoandLulu/chunks.m3u8', headers: {} } }, res)
    assert.equal(handlers.get('streams:list')().length, 2, 'three qualities must create one card')
    events.get('recorder:start')(null, { url: variant })
    assert.equal(fetchedUrl, root + 'playlist.m3u8', 'START must prefer master even when it arrived after a variant')
    await record({ body: { url: 'https://edge-hls.doppiocdn.media/hls/123/master/123_auto.m3u8', headers: {} } }, res)
    assert.equal(response.hidden, true)
    for (const quality of ['_240p', '', '_480p']) {
        await record({ body: { url: `https://media-hls.doppiocdn.media/b-hls-16/123/123${quality}.m3u8?pkey=test`, headers: {} } }, res)
    }
    assert.equal(handlers.get('streams:list')().length, 3, 'Stripchat qualities must share one card')
    await record({ body: { url: root.replace('MaoandLulu', 'AnotherModel') + 'playlist.m3u8', headers: {} } }, res)
    assert.equal(handlers.get('streams:list')().length, 4, 'different broadcasts must stay separate')
    assert.equal(handlers.get('streams:list')()[0].url, 'https://cdn.test/live.m3u8')
    await record(request, res)
    assert.equal(response.duplicate, true)
    assert.equal(handlers.get('streams:list')().length, 4)
    console.log('Passed: streams discovered before window loading remain available to the renderer, including after duplicate requests')
}
test().catch(err => { console.error(err); process.exitCode = 1 })
