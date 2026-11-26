import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  lstatSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The outer process owns fixture paths; the real Electron child runs the same
// compiled launcher/catalog/executor that the desktop Worker loads.
if (!process.argv.includes('--electron-child')) {
  const require = createRequire(import.meta.url)
  const electron = process.env.PEGAS_DESKTOP_EXECUTABLE || require('electron')
  const cli = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  const child = spawn(
    electron,
    [fileURLToPath(import.meta.url), '--electron-child', cli],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
    },
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(code, 0, 'Electron → DSH runtime contract failed')
  } finally {
    clearTimeout(timer)
  }
} else {
  assert(process.versions.electron, 'This gate must execute inside Electron')
  const root = resolve(process.env.PEGAS_RUNTIME_ROOT || '.')
  const load = relative =>
    import(pathToFileURL(join(root, 'dist', relative)).href)
  const { dshLaunch } = await load('executor/dsh-launch.js')
  const { DshCliExecutor } = await load('executor/dsh-cli-executor.js')
  const { loadDshModelCatalog } = await load('executor/dsh-model-catalog.js')
  const { createDshModelConfiguration, ensureDshProfileHome } = await load(
    'executor/dsh-home.js',
  )
  const { ModelCredentialVault } = await load('model/model-credential-vault.js')
  const workspace = mkdtempSync(join(tmpdir(), 'pegas-runtime-gate-'))
  const home = join(workspace, 'dsh-home')
  let configuration
  let requests = 0
  let observedRead = false
  let fixtureError
  const marker = 'PEGAS_RUNTIME_FILE_CONTENT'
  const answer = 'PEGAS_RUNTIME_TOOL_OK'
  const gateway = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      try {
        assert.equal(request.url, '/v1/chat/completions')
        const input = JSON.parse(body)
        requests++
        const result = input.messages.find(
          message =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes(marker),
        )
        observedRead ||= Boolean(result)
        if (!result)
          assert(input.tools.some(tool => tool.function.name === 'read'))
        const delta = result
          ? { content: answer }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: 'runtime-read',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({
                      file_path: join(workspace, 'fixture.txt'),
                    }),
                  },
                },
              ],
            }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const choice of [
          {
            index: 0,
            delta: { role: 'assistant', ...delta },
            finish_reason: null,
          },
          {
            index: 0,
            delta: {},
            finish_reason: result ? 'stop' : 'tool_calls',
          },
        ])
          response.write(
            `data: ${JSON.stringify({ id: 'runtime', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [choice] })}\n\n`,
          )
        response.end('data: [DONE]\n\n')
      } catch (error) {
        fixtureError = error
        response.writeHead(500).end('fixture contract failed')
      }
    })
  })
  try {
    mkdirSync(join(workspace, '.local', 'bin'), { recursive: true })
    symlinkSync(process.argv.at(-1), join(workspace, '.local', 'bin', 'dsh'))
    process.env.HOME = workspace
    process.env.PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
      delimiter,
    )
    for (const key of Object.keys(process.env)) {
      if (/proxy/i.test(key) || /API_KEY|AUTH_TOKEN/.test(key))
        Reflect.deleteProperty(process.env, key)
    }
    const launch = dshLaunch('dsh', [])
    assert.notEqual(
      launch.command,
      process.execPath,
      'DSH must not inherit the Electron executable',
    )
    assert.equal(launch.command, join(root, 'dist', 'runtime', 'node'))
    assert(
      lstatSync(launch.command).isFile(),
      'Runtime must not depend on a worktree symlink',
    )
    const manifest = JSON.parse(
      readFileSync(join(root, 'dist', 'runtime', 'manifest.json'), 'utf8'),
    )
    assert.equal(
      manifest.sha256,
      createHash('sha256').update(readFileSync(launch.command)).digest('hex'),
    )
    assert(
      readFileSync(
        join(root, 'dist', 'runtime', 'LICENSE.node'),
        'utf8',
      ).includes('Node.js'),
    )
    const fingerprint = JSON.parse(
      execFileSync(launch.command, ['-p', 'JSON.stringify(process.versions)'], {
        encoding: 'utf8',
      }),
    )
    assert.equal(fingerprint.electron, undefined)
    assert.equal(fingerprint.node, manifest.node)
    ensureDshProfileHome(home, 'headless')
    writeFileSync(join(workspace, 'fixture.txt'), marker)
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
    const address = gateway.address()
    configuration = createDshModelConfiguration({
      vault: new ModelCredentialVault(Buffer.alloc(32, 7)),
      connections: [
        {
          id: 'magpie',
          name: 'Fixture',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          updatedAt: new Date().toISOString(),
        },
      ],
      agentModel: { provider: 'magpie', model: 'fixture' },
    })
    const catalog = await loadDshModelCatalog({
      home,
      patchPath: configuration.patchPath,
      environment: configuration.environment,
    })
    assert(
      catalog.models.some(
        model => model.provider === 'magpie' && model.id === 'fixture',
      ),
    )
    const executor = new DshCliExecutor({
      home,
      modelConfiguration: configuration,
      permissionMode: 'read-only',
      timeoutMs: 30_000,
    })
    const input = {
      runId: 'runtime-1',
      taskId: 'runtime',
      prompt: 'Read fixture.txt using the read tool.',
      workingDirectory: workspace,
    }
    const result = await executor.execute(input)
    assert.ifError(fixtureError)
    assert.equal(result.output.trim(), answer)
    assert(observedRead, 'A real tool result must reach the model')
    assert.equal(requests, 2)
    assert(result.executorRef, 'A resumable session is required')
    const resumed = await executor.execute({
      ...input,
      runId: 'runtime-2',
      resumeSessionId: result.executorRef,
      prompt: 'Return the previous result.',
    })
    assert.equal(resumed.output.trim(), answer)
    assert.equal(requests, 3)
    console.log(
      JSON.stringify({
        electron: process.versions.electron,
        node: fingerprint.node,
        catalog: 'passed',
        tool: 'passed',
        resume: 'passed',
        requests,
      }),
    )
  } finally {
    configuration?.remove()
    await new Promise(resolve => gateway.close(resolve))
    rmSync(workspace, { recursive: true, force: true })
  }
}
