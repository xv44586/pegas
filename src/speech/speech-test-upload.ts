import { Readable } from 'node:stream'

import { Busboy } from '@fastify/busboy'

export interface SpeechTestUpload {
  speech: string
  audio: Buffer
  audioType: string
}

export function parseSpeechTestUpload(
  body: Buffer,
  contentType: string,
  maximumAudioBytes: number,
): Promise<SpeechTestUpload> {
  return new Promise((resolve, reject) => {
    const parser = new Busboy({
      headers: { 'content-type': contentType },
      limits: {
        fields: 1,
        files: 1,
        parts: 2,
        fieldSize: 20_480,
        fileSize: maximumAudioBytes,
        headerPairs: 20,
      },
    })
    let speech: string | undefined
    let audio: Buffer | undefined
    let audioType = ''
    let invalid = false
    parser.on('field', (name, value, nameTruncated, valueTruncated) => {
      if (name !== 'speech' || nameTruncated || valueTruncated) invalid = true
      else speech = value
    })
    parser.on('file', (name, stream, _filename, _encoding, mimeType) => {
      if (name !== 'audio') {
        invalid = true
        stream.resume()
        return
      }
      audioType = mimeType
      const chunks: Buffer[] = []
      stream.on('data', (chunk: unknown) => {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
        )
      })
      stream.on('end', () => {
        if (stream.truncated) invalid = true
        audio = Buffer.concat(chunks)
      })
    })
    parser.on('partsLimit', () => {
      invalid = true
    })
    parser.on('filesLimit', () => {
      invalid = true
    })
    parser.on('fieldsLimit', () => {
      invalid = true
    })
    parser.on('error', error =>
      reject(error instanceof Error ? error : new Error('录音解析失败')),
    )
    parser.on('finish', () => {
      if (invalid || !speech || !audio || !audioType.startsWith('audio/')) {
        reject(new Error('测试录音无效或过大，请重新录制。'))
        return
      }
      resolve({ speech, audio, audioType })
    })
    Readable.from([body]).pipe(parser)
  })
}
