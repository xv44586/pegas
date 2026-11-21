import type { EvidenceRef, TaskArtifact } from './goal-delivery.js'

export interface TrustedVerifierOutcome {
  result: 'passed' | 'failed'
  method: string
}

/**
 * Deterministic visual-evidence verifier running inside the Control Plane.
 * It re-checks the attested bytes against the Artifact digest, validates the
 * image container signature for the declared MIME type and confirms the
 * intrinsic pixel dimensions match the declared capture viewport. It never
 * trusts producer-supplied verification fields.
 */
export function verifyVisualEvidence(input: {
  evidence: EvidenceRef
  artifact?: TaskArtifact
  artifactBytes?: Buffer
}): TrustedVerifierOutcome {
  const method = 'visual-container-viewport-check'
  const { evidence, artifact, artifactBytes } = input
  if (
    evidence.kind !== 'screenshot' &&
    evidence.kind !== 'render' &&
    evidence.kind !== 'keyframe'
  ) {
    return { result: 'failed', method }
  }
  if (evidence.trustClass !== 'control-plane')
    return { result: 'failed', method }
  if (!artifact || !artifactBytes) return { result: 'failed', method }
  if (!artifact.mimeType?.startsWith('image/'))
    return { result: 'failed', method }
  const dimensions = imageDimensions(artifactBytes, artifact.mimeType)
  if (!dimensions) return { result: 'failed', method }
  const viewport = evidence.environment.viewport as
    { width?: unknown; height?: unknown } | undefined
  if (
    typeof viewport?.width !== 'number' ||
    typeof viewport.height !== 'number' ||
    dimensions.width !== viewport.width ||
    dimensions.height !== viewport.height
  ) {
    return { result: 'failed', method }
  }
  return { result: 'passed', method }
}

/** Reads intrinsic pixel dimensions from PNG, GIF, JPEG or WebP containers. */
function imageDimensions(
  bytes: Buffer,
  mimeType: string,
): { width: number; height: number } | undefined {
  if (mimeType === 'image/png') {
    if (
      bytes.byteLength < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      return undefined
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mimeType === 'image/gif') {
    if (
      bytes.byteLength < 10 ||
      (bytes.toString('ascii', 0, 6) !== 'GIF87a' &&
        bytes.toString('ascii', 0, 6) !== 'GIF89a')
    )
      return undefined
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (mimeType === 'image/jpeg') {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
      return undefined
    let offset = 2
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]
      if (marker === undefined) return undefined
      // SOF0..SOF15 except DHT(C4), JPG(C8) and DAC(CC) carry the frame size.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        }
      }
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2) return undefined
      offset += 2 + length
    }
    return undefined
  }
  if (mimeType === 'image/webp') {
    if (
      bytes.byteLength < 30 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP'
    )
      return undefined
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      }
    }
    if (chunk === 'VP8 ' && bytes.byteLength >= 30) {
      // Lossy keyframe: dimensions live at byte 26 after the start code.
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
        return undefined
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      }
    }
    if (chunk === 'VP8L' && bytes.byteLength >= 25) {
      if (bytes[20] !== 0x2f) return undefined
      const bits = bytes.readUInt32LE(21)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }
    return undefined
  }
  return undefined
}
