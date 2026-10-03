const { ipcRenderer } = require('electron')

const streamsEl = document.getElementById('streams')
const logsEl = document.getElementById('logs')
const logsHeader = document.getElementById('logs-header')
const themeToggle = document.getElementById('theme-toggle')
document.querySelectorAll('[data-window-action]').forEach(button => {
    button.onclick = () => ipcRenderer.send('window:control', button.dataset.windowAction)
})
document.querySelector('.titlebar').ondblclick = event => {
    if (!event.target.closest('button')) ipcRenderer.send('window:control', 'maximize')
}
document.getElementById('copy-logs').onclick = () => {
    require('electron').clipboard.writeText(logsEl.innerText)
    document.getElementById('copy-logs').textContent = 'Логи скопированы'
}

// url -> element
const streams = new Map()

// Theme management
function initTheme() {
    const isLight = localStorage.getItem('theme') === 'light'
    if (isLight) {
        document.body.classList.add('light')
        themeToggle.textContent = '☀️ Light'
    } else {
        document.body.classList.remove('light')
        themeToggle.textContent = '🌙 Dark'
    }
}

themeToggle.onclick = () => {
    const isLight = document.body.classList.toggle('light')
    localStorage.setItem('theme', isLight ? 'light' : 'dark')
    themeToggle.textContent = isLight ? '☀️ Light' : '🌙 Dark'
}

initTheme()

// Toggle logs visibility
logsHeader.onclick = () => {
    logsEl.classList.toggle('visible')
    logsHeader.textContent = logsEl.classList.contains('visible') ? '📋 Logs' : '📋 Logs'
}

// ========================
// FORMATTERS
// ========================

function formatBytes(bytes) {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024
        i++
    }
    return `${bytes.toFixed(2)} ${units[i]}`
}

function formatTime(sec) {
    if (!sec) return '0s'
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}m ${s}s`
}

// ========================
// UI
// ========================

function createStreamUI({ url, label }) {
    if (streams.has(url)) return

    const el = document.createElement('div')
    el.className = 'stream'
    el.dataset.url = url

    el.innerHTML = `
        <button class="stream-close" title="Удалить стрим">×</button>
        <div class="preview"><div class="preview-placeholder"><span>▷</span>Превью загружается</div>
        <img class="stream-thumbnail" src="" alt="Превью трансляции" style="display: none;"></div>
        <div class="stream-content">
            <div class="url"></div>
            <div class="progress">⏱ 0s | 📦 0 B | ⚡ 0x</div>
            <div class="stream-error" style="color: #e55; white-space: pre-wrap; overflow-wrap: anywhere;"></div>
            <div class="stream-actions"><button class="start">Записать</button>
            <button class="stop" disabled>Стоп</button>
            <button class="restart" style="display: none;">Скачать еще раз</button>
            </div>
        </div>
    `
    el.querySelector('.url').textContent = label || url
    el.querySelector('.url').title = url
    el.querySelector('.stream-thumbnail').onload = () => el.querySelector('.preview').classList.add('has-preview')
    el.querySelector('.stream-thumbnail').onerror = () => {
        el.querySelector('.preview').classList.remove('has-preview')
        el.querySelector('.preview-placeholder').textContent = 'Превью недоступно'
    }

    const startBtn = el.querySelector('.start')
    const stopBtn = el.querySelector('.stop')
    const restartBtn = el.querySelector('.restart')
    const closeBtn = el.querySelector('.stream-close')

    startBtn.onclick = () => {
        el.querySelector('.stream-error').textContent = ''
        ipcRenderer.send('recorder:start', { url })
        startBtn.disabled = true
        stopBtn.disabled = false
        restartBtn.style.display = 'none'
        closeBtn.disabled = true
        // Reset progress
        el.querySelector('.progress').textContent = '⏱ 0s | 📦 0 B | ⚡ 0x'
    }

    stopBtn.onclick = () => {
        ipcRenderer.send('recorder:stop', { url })
        startBtn.disabled = true
        stopBtn.disabled = true
        restartBtn.style.display = 'none'
        closeBtn.disabled = true
        el.querySelector('.progress').textContent += ' | Завершение файла…'
    }

    closeBtn.onclick = () => {
        if (closeBtn.disabled) return
        ipcRenderer.send('stream:remove', { url })
    }

    restartBtn.onclick = () => {
        el.querySelector('.stream-error').textContent = ''
        // Reset progress
        el.querySelector('.progress').textContent = '⏱ 0s | 📦 0 B | ⚡ 0x'
        // Start new recording
        ipcRenderer.send('recorder:start', { url })
        startBtn.disabled = true
        stopBtn.disabled = false
        restartBtn.style.display = 'none'
    }

    streamsEl.appendChild(el)
    streams.set(url, el)
    document.getElementById('stream-count').textContent = streams.size
}

function updateProgress({ url, time, size, speed }) {
    const el = streams.get(url)
    if (!el) return

    el.querySelector('.progress').textContent =
        `⏱ ${formatTime(time)} | 📦 ${formatBytes(size)} | ⚡ ${speed}`
}

function setStopped(url) {
    const el = streams.get(url)
    if (!el) return

    el.querySelector('.start').disabled = false
    el.querySelector('.stop').disabled = true
    el.querySelector('.restart').style.display = 'inline-block'
    el.querySelector('.stream-close').disabled = false
}

function removeStream(url) {
    const el = streams.get(url)
    if (el) {
        el.remove()
        streams.delete(url)
        document.getElementById('stream-count').textContent = streams.size
    }
}

function log(msg) {
    const follow = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 30
    const line = document.createElement('div')
    line.textContent = msg
    logsEl.appendChild(line)
    if (follow) logsEl.scrollTop = logsEl.scrollHeight
}

// ========================
// IPC
// ========================

// 🆕 найден стрим (из extension)
ipcRenderer.on('stream:discovered', (_, data) => {
    createStreamUI(data)
})

// ▶️ реально стартовал ffmpeg
ipcRenderer.on('recorder:started', (_, { url }) => {
    log(`▶ recording: ${url}`)
    const el = streams.get(url)
    if (el) {
        el.querySelector('.restart').style.display = 'none'
        el.querySelector('.stream-close').disabled = true
    }
})

// 📊 прогресс
ipcRenderer.on('recorder:progress', (_, data) => {
    updateProgress(data)
})

// ⛔ остановка
ipcRenderer.on('recorder:stopped', (_, { url, code }) => {
    log(`⛔ stopped: ${url} (code ${code})`)
    setStopped(url)
})

// ❌ ошибка
ipcRenderer.on('recorder:error', (_, { url, message }) => {
    log(`❌ error: ${url} → ${message}`)
    logsEl.classList.add('visible')
    const el = streams.get(url)
    if (el) el.querySelector('.stream-error').textContent = message
    setStopped(url)
})

// 🧾 ffmpeg лог
ipcRenderer.on('recorder:log', (_, msg) => {
    log(msg)
})

// 🗑️ стрим удален
ipcRenderer.on('stream:removed', (_, { url }) => {
    removeStream(url)
})

// 🖼️ превью готово
ipcRenderer.on('stream:thumbnail', (_, { url, thumbnailPath }) => {
    const el = streams.get(url)
    if (el) {
        const img = el.querySelector('.stream-thumbnail')
        if (img) {
            img.src = `file://${thumbnailPath}`
            img.style.display = 'block'
        }
    }
})

// Subscribe first, then restore streams discovered before the renderer was ready.
ipcRenderer.invoke('streams:list').then(items => {
    for (const item of items) {
        createStreamUI(item)
        const el = streams.get(item.url)
        if (item.thumbnailPath) {
            const img = el.querySelector('.stream-thumbnail')
            img.src = require('url').pathToFileURL(item.thumbnailPath).href
            img.style.display = 'block'
        }
        if (item.status === 'recording') {
            el.querySelector('.start').disabled = true
            el.querySelector('.stop').disabled = false
            el.querySelector('.stream-close').disabled = true
        }
    }
}).catch(err => log(`Не удалось восстановить список потоков: ${err.message}`))
