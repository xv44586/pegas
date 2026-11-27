import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshCliExecutor } from '../dist/executor/dsh-cli-executor.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../dist/executor/dsh-home.js'
import { ModelCredentialVault } from '../dist/model/model-credential-vault.js'

// Real DSH, synthetic local gateway and credentials. No personal tokens, remote
// accounts, browser sessions or external model calls are used by this gate.
const cli = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
const root = mkdtempSync(join(tmpdir(), 'pegas-credential-smoke-'))
const home = join(root, 'home'),
  workspace = join(root, 'workspace'),
  dshHome = join(root, 'dsh')
const secret = join(home, '.config', 'gh', 'hosts.yml')
const marker = 'SYNTHETIC_ACCOUNT_SECRET_MUST_NOT_REACH_MODEL'
let scenario, failure, configuration
const evidence = []
const gateway = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => {
    body += chunk
  })
  request.on('end', () => {
    try {
      const input = JSON.parse(body)
      const tool = input.messages.findLast(message => message.role === 'tool')
      const result = tool ? JSON.stringify(tool.content) : undefined
      if (result) {
        assert(!result.includes(marker), 'Credential content reached the model')
        scenario.verify(result)
        evidence.push({ scenario: scenario.name, passed: true })
      }
      const delta = result
        ? { content: 'FIXTURE_COMPLETED' }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'fixture-tool',
                type: 'function',
                function: {
                  name: scenario.tool,
                  arguments: JSON.stringify({
                    ...(scenario.tool === 'bash'
                      ? { description: scenario.name }
                      : {}),
                    ...scenario.args,
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
        { index: 0, delta: {}, finish_reason: result ? 'stop' : 'tool_calls' },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [choice] })}\n\n`,
        )
      response.end('data: [DONE]\n\n')
    } catch (error) {
      failure = error
      console.error(scenario.name, error)
      response.writeHead(500).end('Fixture assertion failed')
    }
  })
})
const previous = { ...process.env }
try {
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  mkdirSync(workspace)
  writeFileSync(secret, marker)
  // Establish that the fixture is readable by an unconfined process first.
  assert.equal(execFileSync('/bin/cat', [secret], { encoding: 'utf8' }), marker)
  process.env.HOME = home
  for (const key of Object.keys(process.env))
    if (/proxy/i.test(key)) Reflect.deleteProperty(process.env, key)
  ensureDshProfileHome(dshHome, 'headless')
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  configuration = createDshModelConfiguration({
    vault: new ModelCredentialVault(Buffer.alloc(32, 7)),
    connections: [
      {
        id: 'magpie',
        name: 'Fixture',
        protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
        updatedAt: new Date().toISOString(),
      },
    ],
    agentModel: { provider: 'magpie', model: 'fixture' },
  })
  const script = join(workspace, 'indirect.cjs')
  writeFileSync(
    script,
    'process.stdout.write(require("node:fs").readFileSync(process.argv[2]))',
  )
  const safeFile = join(workspace, 'safe.txt')
  const deny = result =>
    assert.match(result, /账号凭据|not permitted|denied|directory|read-only/i)
  const cases = [
    {
      name: 'native-read',
      tool: 'read',
      args: { file_path: secret },
      verify: deny,
    },
    {
      name: 'opaque-script-full-access',
      tool: 'bash',
      args: {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(secret)}`,
      },
      verify: deny,
    },
    {
      name: 'ordinary-workspace-write',
      tool: 'bash',
      args: { command: `printf safe > ${JSON.stringify(safeFile)}` },
      verify: () => assert.equal(readFileSync(safeFile, 'utf8'), 'safe'),
    },
  ]
  if (process.platform === 'darwin') {
    // Probe only the service port, never query a real Keychain item.
    const probe =
      'import ctypes; lib=ctypes.CDLL("/usr/lib/libSystem.B.dylib"); p=ctypes.c_uint(); status=lib.bootstrap_look_up(ctypes.c_uint.in_dll(lib, "bootstrap_port"), b"com.apple.SecurityServer", ctypes.byref(p)); print("KEYCHAIN_LOOKUP_ALLOWED" if status == 0 else "KEYCHAIN_LOOKUP_DENIED")'
    assert.match(
      execFileSync('/usr/bin/python3', ['-c', probe], { encoding: 'utf8' }),
      /KEYCHAIN_LOOKUP_ALLOWED/,
    )
    const probeFile = join(workspace, 'probe.py')
    writeFileSync(probeFile, probe)
    cases.push({
      name: 'keychain-service',
      tool: 'bash',
      args: { command: `/usr/bin/python3 ${JSON.stringify(probeFile)}` },
      verify: result => assert.match(result, /KEYCHAIN_LOOKUP_DENIED/),
    })
  }
  for (const item of cases) {
    scenario = item
    const executor = new DshCliExecutor({
      command: cli,
      home: dshHome,
      modelConfiguration: configuration,
      permissionMode: 'danger-full-access',
      approvalPolicy: 'never',
      timeoutMs: 20_000,
    })
    const result = await executor.execute({
      runId: item.name,
      taskId: item.name,
      prompt: 'Run the fixture tool once.',
      workingDirectory: workspace,
    })
    if (failure) throw failure
    assert.match(result.output, /FIXTURE_COMPLETED/)
  }
  assert.equal(evidence.length, cases.length)
  console.log(
    JSON.stringify({
      credentialBoundary: 'passed',
      executor: 'real DSH',
      cases: evidence,
    }),
  )
} finally {
  configuration?.remove()
  await new Promise(resolve => gateway.close(resolve))
  process.env = previous
  rmSync(root, { recursive: true, force: true })
}
