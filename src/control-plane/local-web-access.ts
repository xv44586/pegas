import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { endianness } from 'node:os'
import { promisify } from 'node:util'

const maximumPendingPeerChecks = 16
const run = promisify(execFile)
const procLoopback = {
  '127.0.0.1': { LE: '0100007F', BE: '7F000001' },
  '::1': {
    LE: '00000000000000000000000001000000',
    BE: '00000000000000000000000000000001',
  },
}

export function createLocalWebAccess() {
  const peers = new WeakMap<Socket, Promise<boolean>>()
  let pendingPeerChecks = 0
  return function isLocalWebRequest(
    request: IncomingMessage,
  ): Promise<boolean> | false {
    const { socket, headers } = request
    const address = socket.localAddress
    if (
      (address !== '127.0.0.1' && address !== '::1') ||
      socket.remoteAddress !== address ||
      !socket.localPort ||
      !socket.remotePort ||
      !request.url?.startsWith('/v1/') ||
      headers['x-pegas-local-web'] !== '1' ||
      headers['sec-fetch-site'] !== 'same-origin' ||
      (headers['sec-fetch-mode'] !== 'same-origin' &&
        headers['sec-fetch-mode'] !== 'cors') ||
      Object.keys(headers).some(
        header =>
          header === 'forwarded' ||
          header === 'via' ||
          header === 'x-real-ip' ||
          header.startsWith('x-forwarded-'),
      )
    )
      return false

    const port = socket.localPort === 80 ? '' : `:${String(socket.localPort)}`
    const literal = address === '::1' ? '[::1]' : address
    if (
      headers.host !== `localhost${port}` &&
      headers.host !== `${literal}${port}`
    )
      return false
    const origin = `http://${headers.host}`
    if (
      headers.origin !== origin &&
      (headers.origin !== undefined ||
        (request.method !== 'GET' && request.method !== 'HEAD'))
    )
      return false

    // The tuple must describe the client socket, so the server's own socket
    // cannot vouch for a different user. Cache the proof for this connection.
    const owned = peers.get(socket)
    if (owned) return owned
    if (pendingPeerChecks >= maximumPendingPeerChecks) return false
    pendingPeerChecks += 1
    const check = isOwnedPeer(
      address,
      socket.remotePort,
      socket.localPort,
    ).finally(() => {
      pendingPeerChecks -= 1
    })
    peers.set(socket, check)
    return check
  }
}

async function isOwnedPeer(
  address: '127.0.0.1' | '::1',
  clientPort: number,
  serverPort: number,
): Promise<boolean> {
  const uid = process.getuid?.()
  if (uid === undefined) return false
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run(
        '/usr/sbin/lsof',
        [
          '-nP',
          '-a',
          '-u',
          String(uid),
          `-iTCP:${String(serverPort)}`,
          '-sTCP:ESTABLISHED',
          '-F0n',
        ],
        { timeout: 2_000, maxBuffer: 256 * 1024 },
      )
      const host = address === '::1' ? '[::1]' : address
      const client = `n${host}:${String(clientPort)}->${host}:${String(serverPort)}`
      return stdout.split('\0').some(field => field === client)
    }
    if (process.platform === 'linux') {
      const ipv6 = address === '::1'
      const ip = procLoopback[address][endianness()]
      const endpoint = (port: number) =>
        `${ip}:${port.toString(16).toUpperCase().padStart(4, '0')}`
      const client = endpoint(clientPort)
      const server = endpoint(serverPort)
      const table = await readFile(
        ipv6 ? '/proc/net/tcp6' : '/proc/net/tcp',
        'utf8',
      )
      return table.split('\n').some(row => {
        const [, local, remote, state, , , , owner] = row.trim().split(/\s+/)
        return (
          local === client &&
          remote === server &&
          state === '01' &&
          owner === String(uid)
        )
      })
    }
  } catch {
    // Restricted socket tables and unavailable tools require explicit bearer auth.
  }
  return false
}
