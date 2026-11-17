import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenAiTranscriptionProvider } from '../src/speech/openai-transcription-provider.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAiTranscriptionProvider', () => {
  it('sends OpenAI-compatible multipart audio and normalizes the result', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValue(
      Response.json({ text: '  你好，Pegas  ', language: 'zh' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAiTranscriptionProvider({
      baseUrl: 'http://speech.example/v1',
      apiKey: 'not-a-secret',
      model: 'qwen-asr',
    })

    await expect(
      provider.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        contentType: 'audio/webm',
        filename: 'utterance.webm',
        language: 'zh',
      }),
    ).resolves.toEqual({ text: '你好，Pegas', language: 'zh' })

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toEqual(
      new URL('http://speech.example/v1/audio/transcriptions'),
    )
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer not-a-secret' },
    })
    const body = init?.body as FormData
    expect(body.get('model')).toBe('qwen-asr')
    expect(body.get('language')).toBe('zh')
    expect(body.get('file')).toBeInstanceOf(File)
  })

  it('does not accept an empty provider response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ text: ' ' }))),
    )
    const provider = new OpenAiTranscriptionProvider({
      baseUrl: 'http://speech.example/v1',
      model: 'qwen-asr',
    })

    await expect(
      provider.transcribe({
        audio: new Uint8Array([1]),
        contentType: 'audio/wav',
        filename: 'utterance.wav',
      }),
    ).rejects.toThrow('empty transcript')
  })
})
