import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { app, BrowserWindow, Notification, session, shell } from 'electron'

import { ensureInstanceBearer } from '../core/instance-token.js'
import { createDesktopAttentionMonitor } from './attention.js'
import {
  createResidencyController,
  readResidencyPreference,
  type ResidencyController,
} from './residency.js'
import {
  availableLoopbackPort,
  desktopRequestHeaders,
  desktopServiceEnvironment,
  desktopServiceRoot,
  desktopSupervisorRoot,
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
let attentionTimer: NodeJS.Timeout | undefined
let residencyController: ResidencyController | undefined
let residentMode = false
let residencyServer: ReturnType<typeof createServer> | undefined

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
  if (residentMode) return
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
    const port = await availableLoopbackPort()
    appUrl = `http://127.0.0.1:${String(port)}`
    const dataDir =
      process.env.PEGAS_DESKTOP_DATA_DIR ??
      join(app.getPath('userData'), 'data')
    apiToken = ensureInstanceBearer({
      dataDir,
      environment: { PEGAS_API_TOKEN: apiToken },
    })
    const preferenceDirectory =
      process.env.PEGAS_DESKTOP_DATA_DIR ?? app.getPath('userData')
    residentMode = readResidencyPreference(preferenceDirectory).resident
    residencyController = createResidencyController({
      preferenceDirectory,
      applyLoginItem: settings => {
        app.setLoginItemSettings(settings)
      },
      readLoginItem: () => app.getLoginItemSettings(),
    })
    const recoveryPort = await availableLoopbackPort()
    const residencyPort = await availableLoopbackPort()
    await startResidencyServer(apiToken, residencyPort)
    startSupervisorEntry(port, recoveryPort, residencyPort, dataDir, apiToken)
    await waitForControlPlane(appUrl)
  }
  configureSession(appUrl, apiToken)
  await createWindow(appUrl)
  startAttentionMonitor(appUrl, apiToken)
}

function startAttentionMonitor(trustedUrl: string, apiToken?: string): void {
  const origin = new URL(trustedUrl).origin
  const monitor = createDesktopAttentionMonitor({
    fetchSnapshot: async () => {
      const response = await fetch(`${origin}/v1/outbox?userId=owner`, {
        mode: 'same-origin',
        headers: apiToken
          ? { Authorization: `Bearer ${apiToken}` }
          : { 'x-pegas-local-web': '1', 'sec-fetch-site': 'same-origin' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok)
        throw new Error(`outbox poll ${String(response.status)}`)
      return (await response.json()) as unknown
    },
    notificationsSupported: () => Notification.isSupported(),
    notify: notice => {
      const notification = new Notification({
        title: notice.title,
        ...(notice.body ? { body: notice.body } : {}),
      })
      notification.on('click', () => {
        void focusAttentionDeepLink(trustedUrl, notice.deepLink)
      })
      notification.show()
    },
    setBadge: value => {
      if (process.platform === 'darwin') app.dock?.setBadge(value)
    },
  })
  const tick = async (): Promise<void> => {
    if (quitting) return
    await monitor.poll()
    if (serviceFailureHandled) return
    const delay =
      monitor.consecutiveFailures > 0
        ? Math.min(60_000, 3_000 * 2 ** (monitor.consecutiveFailures - 1))
        : 3_000
    attentionTimer = setTimeout(() => void tick(), delay)
  }
  void tick()
}

async function focusAttentionDeepLink(
  trustedUrl: string,
  deepLink: string,
): Promise<void> {
  if (!appUrl) return
  const target = new URL(deepLink, new URL(trustedUrl).origin).toString()
  if (!mainWindow) await createWindow(appUrl)
  const window = mainWindow
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  app.focus({ steal: true })
  await window.loadURL(target)
}

function startSupervisorEntry(
  port: number,
  recoveryPort: number,
  residencyPort: number,
  dataDir: string,
  apiToken: string,
): void {
  const applicationRoot = desktopServiceRoot({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
  // Hot-release boot: prefer the staged release recorded by the Supervisor
  // state over the copy bundled in the app, so server fixes ship as
  // immutable candidates without repackaging the desktop app.
  const supervisorStatePath = join(dataDir, 'supervisor.json')
  const serviceRoot = desktopSupervisorRoot({
    fallbackRoot: applicationRoot,
    statePath: supervisorStatePath,
  })
  const environment = desktopServiceEnvironment({
    port,
    dataDir,
    apiToken,
    testMode: process.env.PEGAS_DESKTOP_TEST === '1',
  })
  const entry = 'supervisor/main.js'
  const child = spawn(process.execPath, [join(serviceRoot, 'dist', entry)], {
    cwd: serviceRoot,
    detached: process.platform !== 'win32',
    env: {
      ...environment,
      PEGAS_SUPERVISOR_STATE: supervisorStatePath,
      PEGAS_RECOVERY_HOST: '127.0.0.1',
      PEGAS_RECOVERY_PORT: String(recoveryPort),
      PEGAS_DESKTOP_RESIDENCY_URL: `http://127.0.0.1:${String(residencyPort)}`,
      PEGAS_RELEASE_ROOT: serviceRoot,
      // App-lifecycle mode: the shell owns restarts. A business-process
      // death must fail the window honestly, not silently resurrect.
      PEGAS_SUPERVISOR_RESTART: 'disabled',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.once('error', error => handleServiceFailure(entry, error.message))
  child.once('exit', (code, signal) => handleServiceExit(entry, code, signal))
  children.push(child)
}

/**
 * Machine-local residency API for the sealed settings page. It lives in the
 * Electron main process (not the Control Plane) because residency describes
 * how processes live on this Mac. Same instance bearer; loopback only; the
 * token never reaches the renderer.
 */
async function startResidencyServer(
  apiToken: string,
  port: number,
): Promise<void> {
  const server = createServer((request, response) => {
    void handleResidencyRequest(request, response, apiToken)
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  residencyServer = server
}

async function handleResidencyRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  apiToken: string,
): Promise<void> {
  const sendJson = (status: number, body: unknown): void => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': new URL(appUrl).origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
    })
    response.end(JSON.stringify(body))
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': new URL(appUrl).origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
    })
    response.end()
    return
  }
  if (request.headers.authorization !== `Bearer ${apiToken}`)
    return sendJson(401, { error: 'unauthorized' })
  if (!residencyController)
    return sendJson(503, { error: 'residency_unavailable' })
  if (request.url === '/desktop/residency' && request.method === 'GET')
    return sendJson(200, residencyController.state())
  if (request.url === '/desktop/residency' && request.method === 'PUT') {
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      if (body.length > 4096) return sendJson(413, { error: 'body_too_large' })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return sendJson(400, { error: 'bad_request' })
    }
    const resident = (parsed as { resident?: unknown }).resident
    if (typeof resident !== 'boolean')
      return sendJson(400, { error: 'bad_request' })
    try {
      const state = residencyController.setResident(resident)
      residentMode = state.resident
      return sendJson(200, state)
    } catch (error) {
      return sendJson(500, {
        error: 'residency_switch_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }
  return sendJson(404, { error: 'not_found' })
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
  if (attentionTimer) clearTimeout(attentionTimer)
  attentionTimer = undefined
  if (process.platform === 'darwin') app.dock?.setBadge('')
  residencyServer?.close()
  residencyServer = undefined
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
