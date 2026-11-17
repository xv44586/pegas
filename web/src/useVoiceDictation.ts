import { useCallback, useEffect, useRef, useState } from 'react'

import type { VoiceTranscript } from './api'

export type DictationState =
  'idle' | 'requesting' | 'recording' | 'transcribing'

interface UseVoiceDictationOptions {
  transcribe: (audio: Blob) => Promise<VoiceTranscript>
  onTranscript: (text: string) => void
  maximumSeconds?: number
}

const preferredMimeTypes = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

export function useVoiceDictation({
  transcribe,
  onTranscript,
  maximumSeconds = 60,
}: UseVoiceDictationOptions) {
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const interval = useRef<number | undefined>(undefined)
  const mounted = useRef<boolean>(true)
  const transcribeRef = useRef(transcribe)
  const onTranscriptRef = useRef(onTranscript)

  transcribeRef.current = transcribe
  onTranscriptRef.current = onTranscript

  const releaseStream = useCallback(() => {
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
  }, [])

  const clearTimer = useCallback(() => {
    if (interval.current !== undefined) window.clearInterval(interval.current)
    interval.current = undefined
  }, [])

  const fail = useCallback(
    (message: string) => {
      clearTimer()
      releaseStream()
      const activeRecorder = recorder.current
      if (activeRecorder) {
        activeRecorder.ondataavailable = null
        activeRecorder.onerror = null
        activeRecorder.onstop = null
        if (activeRecorder.state === 'recording') activeRecorder.stop()
      }
      recorder.current = null
      chunks.current = []
      if (!mounted.current) return
      setState('idle')
      setElapsedSeconds(0)
      setError(message)
    },
    [clearTimer, releaseStream],
  )

  const finishTranscription = useCallback(async () => {
    if (!mounted.current) return
    const audio = new Blob(chunks.current, {
      type: recorder.current?.mimeType ?? 'application/octet-stream',
    })
    chunks.current = []
    recorder.current = null
    if (!audio.size) {
      fail('没有录到声音，请靠近麦克风后重试。')
      return
    }

    try {
      const transcript = await transcribeRef.current(audio)
      if (transcript.text.trim())
        onTranscriptRef.current(transcript.text.trim())
      setState('idle')
      setElapsedSeconds(0)
      setError(
        transcript.text.trim() ? '' : '没有识别到文字，请说得更清楚一些。',
      )
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : '语音转写失败，请重试。')
    }
  }, [fail])

  const stop = useCallback(() => {
    if (recorder.current?.state !== 'recording') return
    clearTimer()
    setState('transcribing')
    recorder.current.stop()
    releaseStream()
  }, [clearTimer, releaseStream])

  const start = useCallback(async () => {
    const mediaDevices = (
      navigator as unknown as { mediaDevices?: MediaDevices }
    ).mediaDevices
    if (
      typeof MediaRecorder === 'undefined' ||
      typeof mediaDevices?.getUserMedia !== 'function'
    ) {
      setError('当前浏览器不支持录音，请换用最新版浏览器。')
      return
    }

    setError('')
    setElapsedSeconds(0)
    setState('requesting')
    try {
      // Let the browser use the operating system's default microphone. Adding
      // processing constraints here can make macOS prefer an iPhone Continuity
      // microphone even when the Mac's built-in microphone is the default.
      const nextStream = await mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) {
        nextStream.getTracks().forEach(track => track.stop())
        return
      }
      stream.current = nextStream
      const mimeType = preferredMimeTypes.find(type =>
        MediaRecorder.isTypeSupported(type),
      )
      const nextRecorder = new MediaRecorder(
        nextStream,
        mimeType ? { mimeType } : undefined,
      )
      chunks.current = []
      recorder.current = nextRecorder
      nextRecorder.ondataavailable = event => {
        if (event.data.size) chunks.current.push(event.data)
      }
      nextRecorder.onerror = () => fail('录音中断，请检查麦克风后重试。')
      nextRecorder.onstop = () => void finishTranscription()
      nextRecorder.start(250)
      setState('recording')
      interval.current = window.setInterval(() => {
        setElapsedSeconds(current => {
          const next = current + 1
          if (next >= maximumSeconds) window.setTimeout(stop, 0)
          return next
        })
      }, 1000)
    } catch (caught) {
      const name = caught instanceof DOMException ? caught.name : ''
      fail(
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在浏览器设置中允许后重试。'
          : name === 'NotFoundError'
            ? '没有找到可用的麦克风。'
            : '无法启动麦克风，请检查设备后重试。',
      )
    }
  }, [fail, finishTranscription, maximumSeconds, stop])

  const toggle = useCallback(() => {
    if (state === 'recording') stop()
    else if (state === 'idle') void start()
  }, [start, state, stop])

  useEffect(
    () => () => {
      mounted.current = false
      clearTimer()
      const activeRecorder = recorder.current
      if (activeRecorder) {
        activeRecorder.ondataavailable = null
        activeRecorder.onerror = null
        activeRecorder.onstop = null
        if (activeRecorder.state === 'recording') activeRecorder.stop()
      }
      recorder.current = null
      releaseStream()
    },
    [clearTimer, releaseStream],
  )

  return {
    elapsedSeconds,
    error,
    state,
    toggle,
  }
}
