import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed-ui.css'),
  'utf8',
)

function themeBlock(selector: string): string {
  const start = stylesheet.indexOf(selector)
  if (start === -1) throw new Error(`Missing theme block: ${selector}`)
  const open = stylesheet.indexOf('{', start)
  let depth = 1
  let index = open + 1
  while (depth > 0 && index < stylesheet.length) {
    const character = stylesheet[index]
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    index += 1
  }
  return stylesheet.slice(open + 1, index - 1)
}

function tokens(selector: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const match of themeBlock(selector).matchAll(
    /--([\w-]+):\s*([^;]+);/g,
  )) {
    const name = match[1]
    const value = match[2]
    if (name && value) values.set(name, value.trim())
  }
  return values
}

function resolveToken(
  theme: Map<string, string>,
  base: Map<string, string>,
  name: string,
): string {
  const raw = theme.get(name) ?? base.get(name)
  if (!raw) throw new Error(`Missing token: ${name}`)
  const reference = /^var\(--([\w-]+)(?:,\s*var\(--([\w-]+)\))?\)$/.exec(raw)
  if (reference) {
    const primary = reference[1]
    const fallback = reference[2]
    if (primary && (theme.has(primary) || base.has(primary)))
      return resolveToken(theme, base, primary)
    if (fallback) return resolveToken(theme, base, fallback)
    throw new Error(`Unresolvable token: ${raw}`)
  }
  return raw
}

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const expanded =
    value.length === 3
      ? value.replace(/./g, character => character + character)
      : value
  const channels = [0, 2, 4].map(offset => {
    const channel =
      Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  const [red = 0, green = 0, blue = 0] = channels
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  )
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05)
}

describe('sealed UI status color contrast', () => {
  const base = tokens(':root {')
  const themes: [string, Map<string, string>][] = [
    ['light', base],
    ['warm', tokens(":root[data-theme='warm']")],
  ]

  it.each(themes)(
    '%s theme keeps metric and active-nav text at AA contrast',
    (_label, theme) => {
      const read = (name: string) => resolveToken(theme, base, name)
      const surfaces = [read('canvas'), read('surface'), read('surface-raised')]
      for (const surface of surfaces) {
        expect(contrast(read('positive'), surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(read('caution'), surface)).toBeGreaterThanOrEqual(4.5)
      }
      expect(
        contrast(read('positive'), read('positive-soft')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(read('caution'), read('caution-soft')),
      ).toBeGreaterThanOrEqual(4.5)
      const accentInk =
        theme.get('accent-ink') ?? resolveToken(theme, base, 'accent')
      expect(contrast(accentInk, read('accent-soft'))).toBeGreaterThanOrEqual(
        4.5,
      )
    },
  )
})
