#!/usr/bin/env node
/**
 * DSH Desktop — Electron shell for the DeepSeek Harness web GUI.
 *
 * This file is the whole "client" story: locate a dsh CLI, attach to an
 * already-running `dsh web` on the target port or spawn one, then open a
 * native window that loads the GUI. The harness is never modified: the
 * window is a plain Chromium client, so the full extension surface (host
 * plugins, client plugin bundles served under /plugins/, __DSH_BOOT__ boot
 * manifest, SSE/WebSocket channels) keeps working unchanged.
 *
 * Runtime resolution order:
 *   1. $DSH_CLI            — explicit path to a dsh entry script (.ts => tsx source launch)
 *   2. packaged runtime    — resources/dsh-runtime/lib/bin.js (shipped by `bundle:runtime`)
 *   3. repo checkout       — apps/cli/src/bin.ts (source launch) or apps/cli/lib/bin.js (built)
 *
 * The dsh child MUST run under a real Node runtime, never Electron's embedded
 * Node: the vendored loader's internal-import machinery relies on the
 * node-addon-require-builtin addon, which refuses Electron's node
 * ("Unsupported/no-realm"); without it every loader-created bare plugin
 * import fails to resolve. Node binary resolution order:
 *   1. $DSH_NODE                      — explicit path to a node executable
 *   2. packaged portable runtime      — resources/dsh-runtime/node/node.exe
 *   3. `node` on PATH                 — the system Node (dev mode)
 *
 * Tray + auto-update: packaged builds live in the system tray (closing the
 * window only hides it); the tray menu offers "检查更新…". Updates use
 * electron-updater with a generic feed (resources/app-update.yml, built with
 * DSH_UPDATE_URL) — new versions download in the background and install on
 * restart. All diagnostics go to %APPDATA%/dsh-desktop/dsh-desktop.log.
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// electron-updater is CommonJS; its named exports are not re-exported to ESM.
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const here = dirname(fileURLToPath(import.meta.url))
const isPackaged = app.isPackaged

/** App log path: %APPDATA%/dsh-desktop/dsh-desktop.log — resolved from env so it works before app is ready. */
const APP_LOG_PATH = join(process.env.APPDATA ?? '', 'dsh-desktop', 'dsh-desktop.log')

/** Best-effort append to the app log; never throws. */
function appLog(message) {
  try {
    appendFileSync(APP_LOG_PATH, `${message}\n`)
  } catch {
    // diagnostics are best-effort
  }
}
appLog(`[dsh-desktop] boot v${app.getVersion()} packaged=${app.isPackaged} node=${process.versions.node}`)

/** Host/port of the web profile. Overridable so a second instance can be tested side by side. */
const HOST = process.env.DSH_WEB_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DSH_WEB_PORT) || 3080
const WEB_URL = `http://${HOST}:${PORT}`
/** How long to wait for a freshly spawned harness to come up. */
const READY_TIMEOUT_MS = 120_000
/** How long one probe request may take before the port counts as not serving DSH. */
const PROBE_TIMEOUT_MS = 1_500

/**
 * Probe whether `WEB_URL` is served by a dsh web instance: the index tap
 * always injects the boot manifest, whose marker string identifies the GUI.
 * @returns whether the port currently serves the DSH web GUI.
 */
async function probe() {
  try {
    const response = await fetch(WEB_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return false
    const body = await response.text()
    return body.includes('__DSH_BOOT__')
  } catch {
    return false
  }
}

/**
 * Resolve the dsh entry to launch.
 * @returns the entry descriptor, or null when nothing usable exists on disk.
 */
function resolveDsh() {
  const envCli = process.env.DSH_CLI
  if (envCli && existsSync(envCli)) {
    return { kind: envCli.endsWith('.ts') ? 'source' : 'bin', entry: envCli, anchor: dirname(envCli) }
  }
  if (isPackaged) {
    const runtimeRoot = join(process.resourcesPath, 'dsh-runtime')
    const bundled = join(runtimeRoot, 'lib', 'bin.js')
    if (existsSync(bundled)) return { kind: 'bin', entry: bundled, anchor: runtimeRoot }
    return null
  }
  const repo = resolve(here, '..')
  const sourceEntry = join(repo, 'apps', 'cli', 'src', 'bin.ts')
  if (existsSync(sourceEntry)) return { kind: 'source', entry: sourceEntry, anchor: repo }
  const builtEntry = join(repo, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(builtEntry)) return { kind: 'bin', entry: builtEntry, anchor: repo }
  return null
}

/**
 * Resolve the Node runtime that will execute the dsh child. Electron's own
 * embedded Node is never used (see the module docstring for why).
 * @returns the absolute node executable path, or null when nothing is found.
 */
function resolveNode() {
  const envNode = process.env.DSH_NODE
  if (envNode && existsSync(envNode)) return envNode
  if (isPackaged) {
    const portable = join(process.resourcesPath, 'dsh-runtime', 'node', 'node.exe')
    if (existsSync(portable)) return portable
    return null
  }
  // Dev: the system Node via PATH (Windows CreateProcess appends .exe).
  return 'node'
}

/**
 * Spawn `dsh web` under the resolved Node runtime, teeing output to the log.
 * @param nodeBin - the node executable path.
 * @param dsh - the resolved dsh entry descriptor.
 * @returns the child plus its log path.
 */
function spawnDsh(nodeBin, dsh) {
  const logPath = join(app.getPath('userData'), 'dsh-web.log')
  const log = createWriteStream(logPath, { flags: 'a' })
  const args = dsh.kind === 'source'
    ? ['--import', 'tsx/esm', dsh.entry, 'web', '--host', HOST, '--port', String(PORT)]
    : [dsh.entry, 'web', '--host', HOST, '--port', String(PORT)]
  const child = spawn(nodeBin, args, {
    cwd: dsh.anchor,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const tee = (chunk) => log.write(chunk)
  child.stdout.on('data', tee)
  child.stderr.on('data', tee)
  child.on('error', (error) => log.write(`[dsh-desktop] spawn error: ${String(error.stack ?? error)}\n`))
  return { child, logPath }
}

/** Poll the probe until the GUI responds or the deadline passes. */
async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  return false
}

/** Last `lines` of the harness log, for error dialogs. */
function logTail(logPath, lines = 30) {
  try {
    return readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return '(日志不可用)'
  }
}

/** The main window: a locked-down webview that only ever loads the local GUI. */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'DSH Desktop',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  // Closing the window keeps the harness alive in the tray; only the tray's
  // "退出" (or app.quit()) performs a real shutdown.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
    if (tray && !trayHintShown) {
      trayHintShown = true
      tray.displayBalloon('DSH Desktop', '已最小化到托盘，双击图标可重新打开。')
    }
  })
  win.on('closed', () => diag('window closed'))
  win.webContents.on('did-finish-load', () => diag('window finished loading the GUI'))
  win.webContents.on('did-fail-load', (_event, code, description) => diag(`window failed to load (${code} ${description})`))
  // The GUI is a local web app; there is nothing for a preload or IPC to do.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(WEB_URL)) event.preventDefault()
  })
  return win
}

let mainWindow = null
/** The dsh child this instance spawned (null in attach mode: we never kill what we don't own). */
let ownedChild = null
let ownedLogPath = null

/** True once the user asked to quit (tray menu): the window close is then real. */
let isQuitting = false
let tray = null
let trayHintShown = false
let updateChecking = false

/** The app icon for tray/window: packaged resources, or the repo build output in dev. */
function appIconPath() {
  const candidates = isPackaged
    ? [join(process.resourcesPath, 'app-icon.png')]
    : [join(here, 'build', 'icon.png')]
  return candidates.find((path) => existsSync(path))
}

/**
 * Whether a real update feed is configured. electron-builder writes
 * resources/app-update.yml at pack time; the placeholder .invalid URL means
 * `dist` ran without DSH_UPDATE_URL. A runtime DSH_UPDATE_URL override wins.
 */
function updateFeedConfigured() {
  if (process.env.DSH_UPDATE_URL) return true
  if (!isPackaged) return false
  try {
    const config = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
    return !config.includes('.invalid')
  } catch {
    return false
  }
}

/** Wire the electron-updater event flow (packaged builds only). */
function setupAutoUpdater() {
  if (!isPackaged) return
  if (process.env.DSH_UPDATE_URL) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DSH_UPDATE_URL })
      diag(`update feed overridden by DSH_UPDATE_URL: ${process.env.DSH_UPDATE_URL}`)
    } catch (error) {
      diag('setFeedURL failed', error)
    }
  }
  // The update flow is "automatic": new versions download in the background
  // and the user is asked once to restart and install.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (message) => diag(`autoUpdater: ${message}`),
    warn: (message) => diag(`autoUpdater: ${message}`),
    error: (message) => diag(`autoUpdater: ${message}`),
    debug: (message) => diag(`autoUpdater: ${message}`),
  }
  autoUpdater.on('update-available', (info) => {
    diag(`update available: ${info.version}`)
    if (tray) tray.displayBalloon('DSH Desktop', `发现新版本 ${info.version}，正在后台下载…`)
  })
  autoUpdater.on('update-not-available', (info) => {
    diag(`update not available (current ${info.version})`)
  })
  autoUpdater.on('download-progress', (progress) => {
    if (progress.percent % 25 < 1) diag(`update download: ${Math.floor(progress.percent)}%`)
  })
  autoUpdater.on('update-downloaded', async (info) => {
    diag(`update downloaded: ${info.version}`)
    // Test hook: install without asking (used by the automated update check).
    if (process.env.DSH_AUTO_INSTALL === '1') {
      autoUpdater.quitAndInstall()
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'DSH Desktop',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '重启应用即可完成安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', (error) => {
    diag('autoUpdater error', error)
  })
}

/**
 * Check for updates. Manual (tray menu) runs show result dialogs; the
 * automatic startup check stays silent unless a real problem occurs.
 */
async function checkForUpdates(manual = false) {
  if (!isPackaged) {
    if (manual) void dialog.showMessageBox({ type: 'info', message: '开发模式不检查更新。', detail: '打包后的安装版本才会启用自动更新。' })
    return
  }
  if (!updateFeedConfigured()) {
    if (manual) {
      void dialog.showMessageBox({
        type: 'warning',
        message: '未配置更新源',
        detail: '打包时未设置 DSH_UPDATE_URL（当前为占位地址）。\n请用 `DSH_UPDATE_URL=<服务器地址> npm run dist` 重新打包，或将产物与 latest.yml 上传到更新服务器。',
      })
    }
    return
  }
  if (updateChecking) return
  updateChecking = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    diag('checkForUpdates failed', error)
    if (manual) {
      void dialog.showMessageBox({
        type: 'error',
        message: '检查更新失败',
        detail: `无法访问更新源：${String(error.message ?? error)}`,
      })
    }
  } finally {
    updateChecking = false
  }
}

/** Show the main window (tray menu / icon click). */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Build the tray icon with the update entry point. */
function createTray() {
  const iconPath = appIconPath()
  if (!iconPath) {
    diag('tray icon missing, skipping tray')
    return
  }
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.setToolTip('DSH Desktop')
  const menu = Menu.buildFromTemplate([
    { label: '打开 DSH Desktop', click: showMainWindow },
    { label: '检查更新…', click: () => void checkForUpdates(true) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', showMainWindow)
}

/** Crash/exit diagnostics: always recorded to the app log; the harness log too when present. */
let inDiag = false
function diag(message, error) {
  // Re-entry guard: the EPIPE below can surface asynchronously on the stream,
  // so a console write inside the handler must not re-enter it.
  if (inDiag) return
  inDiag = true
  const line = `[dsh-desktop] ${message}${error ? `: ${String(error.stack ?? error)}` : ''}`
  try {
    console.error(line)
  } catch {
    // console may be a closed pipe — the app log below still records it
  }
  appLog(line)
  if (ownedLogPath) {
    try {
      appendFileSync(ownedLogPath, `${line}\n`)
    } catch {
      // diagnostics are best-effort
    }
  }
  inDiag = false
}
// A broken console pipe (e.g. quitting while a supervisor holds the stdout
// pipe) raises EPIPE asynchronously on the stream; without these handlers it
// becomes an uncaughtException and can loop through diag forever. A GUI app
// must never die because its console reader went away.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') return
    diag('console stream error', error)
  })
}
process.on('uncaughtException', (error) => {
  diag('uncaughtException', error)
  app.exit(1)
})
process.on('unhandledRejection', (reason) => {
  diag('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId('com.deepseek-ai.dsh-desktop')
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    createTray()
    setupAutoUpdater()
    mainWindow = createWindow()
    await mainWindow.loadFile(join(here, 'loading.html'))
    diag(`target ${WEB_URL}`)

    const dsh = resolveDsh()
    if (!dsh) {
      dialog.showErrorBox(
        'DSH Desktop 无法启动',
        '找不到 dsh CLI。\n\n'
        + '开发模式：在仓库 checkout 下运行（需要 apps/cli 源码或已构建的 lib）。\n'
        + '安装版：缺少 resources/dsh-runtime（先运行 npm run bundle:runtime）。\n'
        + '也可以用 DSH_CLI 环境变量指定 dsh 入口脚本的路径。',
      )
      app.quit()
      return
    }

    const nodeBin = resolveNode()
    if (!nodeBin) {
      dialog.showErrorBox(
        'DSH Desktop 无法启动',
        '找不到 Node 运行时。\n\n'
        + '安装版：缺少 resources/dsh-runtime/node（先运行 npm run bundle:runtime）。\n'
        + '开发模式：请确保 node 在 PATH 上，或用 DSH_NODE 指定 node 可执行文件路径。',
      )
      app.quit()
      return
    }

    if (await probe()) {
      diag('attach mode: a dsh web instance is already serving the GUI')
    } else {
      diag('spawn mode: starting dsh web')
      const { child, logPath } = spawnDsh(nodeBin, dsh)
      ownedChild = child
      ownedLogPath = logPath
      child.on('exit', (code, signal) => {
        if (ownedChild !== child) return
        ownedChild = null
        dialog.showErrorBox(
          'DSH Desktop',
          `dsh web 进程已退出 (code=${String(code)} signal=${String(signal)})。\n\n日志尾部：\n${logTail(logPath)}`,
        )
        app.quit()
      })
      const ready = await waitForReady(READY_TIMEOUT_MS)
      if (!ready) {
        dialog.showErrorBox(
          'DSH Desktop 启动超时',
          `等待 ${WEB_URL} 就绪超时（${READY_TIMEOUT_MS / 1000}s）。\n\n日志尾部：\n${logTail(ownedLogPath)}`,
        )
        app.quit()
        return
      }
    }

    diag('loading GUI')
    try {
      await mainWindow.loadURL(WEB_URL)
      diag('loadURL resolved')
    } catch (error) {
      diag('loadURL rejected', error)
      throw error
    }

    // Silent automatic update check once the GUI is up (packaged builds only).
    if (app.isPackaged && updateFeedConfigured()) {
      setTimeout(() => void checkForUpdates(false), 8_000)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      void mainWindow.loadURL(WEB_URL)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    diag('before-quit')
    // Only the child we spawned: an attached external harness keeps running.
    if (ownedChild) {
      const child = ownedChild
      ownedChild = null
      diag('killing owned dsh child')
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  })
}
