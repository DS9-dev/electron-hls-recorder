const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'hls-ui-preview-')))
ipcMain.handle('streams:list', () => [])
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, frame: false, width: 1100, height: 780, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    await win.loadFile(path.resolve('index.html'))
    await win.webContents.executeJavaScript(`
        for (let i = 0; i < 6; i++) {
            createStreamUI({ url: 'https://example.test/' + i + '.m3u8', label: ['MaoandLulu', 'Emili', 'Stripchat · 263141605'][i % 3] + ' · Лучшее доступное качество' });
        }
        document.body.classList.add('light');
    `)
    for (const [width, count] of [[640, 2], [1100, 3], [1400, 4]]) {
        win.setSize(width, 780)
        const columns = await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(getComputedStyle(document.getElementById('streams')).gridTemplateColumns.split(' ').length))))`)
        if (columns !== count) throw new Error(`Width ${width}: expected ${count} columns, got ${columns}`)
        console.log(`Verified ${width}px: ${columns} columns`)
    }
    win.setSize(1100, 780)
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.resolve('tests/ui-preview.png'), (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript("document.body.classList.remove('light')")
    fs.writeFileSync(path.resolve('tests/ui-preview-dark.png'), (await win.webContents.capturePage()).toPNG())
    app.quit()
}).catch(error => { console.error(error); app.exit(1) })
