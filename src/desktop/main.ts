import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { app, BrowserWindow, session, shell } from 'electron'

import {
  availableLoopbackPort,
  desktopRequestHeaders,
  desktopServiceEnvironment,
  desktopServiceRoot,
  isLoopbackAppUrl,
  isTrustedAppUrl,
  terminateDesktopChildren,
  waitForControlPlane,
} from './runtime.js'

const children: ChildProcess[] = []
let mainWindow: BrowserWindow | undefined
let appUrl = ''
let quitting = false
let shutdownComplete = false
let shutdownPromise: Promise<void> | undefined
let quitAfterShutdownRequested = false
let serviceFailureHandled = false

app.setName('Pegas')

app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (quitAfterShutdownRequested) return
  quitAfterShutdownRequested = true
  quitting = true
  void beginShutdown().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!mainWindow && appUrl) void createWindow(appUrl)
})

void app.whenReady().then(startDesktop).catch(showStartupFailure)

async function startDesktop(): Promise<void> {
  const externalUrl = process.env.PEGAS_DESKTOP_SERVER_URL
  let apiToken = process.env.PEGAS_API_TOKEN
  if (externalUrl) {
    if (!isLoopbackAppUrl(externalUrl))
      throw new Error('PEGAS_DESKTOP_SERVER_URL must use a loopback HTTP URL')
    appUrl = externalUrl
  } else {
    apiToken ??= randomBytes(32).toString('base64url')
    const port = await availableLoopbackPort()
    appUrl = `http://127.0.0.1:${String(port)}`
    const dataDir =
      process.env.PEGAS_DESKTOP_DATA_DIR ??
      join(app.getPath('userData'), 'data')
    await mkdir(dataDir, { recursive: true })
    startServiceEntries(port, dataDir, apiToken, ['control-plane/main.js'])
    await waitForControlPlane(appUrl)
    startServiceEntries(port, dataDir, apiToken, [
      'worker/main.js',
      'scheduler/main.js',
    ])
  }
  configureSession(appUrl, apiToken)
  await createWindow(appUrl)
}

function startServiceEntries(
  port: number,
  dataDir: string,
  apiToken: string,
  entries: string[],
): void {
  const applicationRoot = desktopServiceRoot({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
  const environment = desktopServiceEnvironment({
    port,
    dataDir,
    apiToken,
    testMode: process.env.PEGAS_DESKTOP_TEST === '1',
  })
  for (const entry of entries) {
    const child = spawn(
      process.execPath,
      [join(applicationRoot, 'dist', entry)],
      {
        cwd: applicationRoot,
        detached: process.platform !== 'win32',
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.once('error', error => handleServiceFailure(entry, error.message))
    child.once('exit', (code, signal) => handleServiceExit(entry, code, signal))
    children.push(child)
  }
}

async function createWindow(trustedUrl: string): Promise<void> {
  const window = new BrowserWindow({
    title: 'Pegas',
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://'))
      void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedAppUrl(url, trustedUrl)) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://'))
      void shell.openExternal(url)
  })
  window.once('ready-to-show', () => window.show())
  await window.loadURL(trustedUrl)
}

function configureSession(trustedUrl: string, apiToken?: string): void {
  if (apiToken) {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: [`${new URL(trustedUrl).origin}/*`] },
      (details, callback) => {
        callback({
          requestHeaders: desktopRequestHeaders(
            details.url,
            trustedUrl,
            apiToken,
            details.requestHeaders,
          ),
        })
      },
    )
  }
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      permission === 'media' &&
      Boolean(webContents) &&
      isTrustedAppUrl(requestingOrigin, trustedUrl) &&
      details.mediaType === 'audio',
  )
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes =
        ('mediaTypes' in details ? details.mediaTypes : undefined) ?? []
      callback(
        permission === 'media' &&
          isTrustedAppUrl(webContents.getURL(), trustedUrl) &&
          mediaTypes.length > 0 &&
          mediaTypes.every(type => type === 'audio'),
      )
    },
  )
}

function stopChildren(): Promise<void> {
  return terminateDesktopChildren(children.splice(0))
}

function beginShutdown(): Promise<void> {
  shutdownPromise ??= stopChildren()
  return shutdownPromise
}

function handleServiceExit(
  entry: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (quitting || serviceFailureHandled) return
  const reason = String(code ?? signal ?? 'unknown')
  handleServiceFailure(entry, reason)
}

function handleServiceFailure(entry: string, reason: string): void {
  if (quitting || serviceFailureHandled) return
  serviceFailureHandled = true
  const message = `Pegas desktop service ${entry} stopped unexpectedly (${reason})`
  console.error(message)
  void beginShutdown()
  showFailurePage(message)
}

function showStartupFailure(caught: unknown): void {
  const message = caught instanceof Error ? caught.message : 'Unknown error'
  console.error('Pegas desktop failed to start', caught)
  if (!serviceFailureHandled) serviceFailureHandled = true
  void beginShutdown()
  showFailurePage(message)
}

function showFailurePage(message: string): void {
  appUrl = ''
  const escaped = message
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  const failureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<main style="font:15px -apple-system;padding:56px;color:#171716"><h1>Pegas 服务已停止</h1><p>本机服务没有正常运行，Pegas 已停止接收新任务。</p><pre style="white-space:pre-wrap;background:#f7f7f5;padding:16px;border-radius:12px">${escaped}</pre><p>退出应用后重新打开；数据不会被删除。</p></main>`)}`
  const window =
    mainWindow ??
    new BrowserWindow({
      title: 'Pegas 服务已停止',
      width: 720,
      height: 460,
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
  mainWindow = window
  window.setTitle('Pegas 服务已停止')
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  void window.loadURL(failureUrl)
}
