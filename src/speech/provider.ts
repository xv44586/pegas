export interface SpeechAudioInput {
  audio: Uint8Array
  filename: string
  contentType: string
  language?: string
  signal?: AbortSignal
}

export interface SpeechTranscript {
  text: string
  language?: string
}

/** Converts one completed user utterance into text. */
export interface SpeechRecognitionProvider {
  readonly name: string
  readonly model: string
  transcribe(input: SpeechAudioInput): Promise<SpeechTranscript>
}
