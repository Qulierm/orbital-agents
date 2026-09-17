/**
 * Seam pixel-checker regression: synthetic renders prove the checker rejects
 * page-background cutouts and dark hairline rows, and accepts a clean junction.
 */

import { describe, expect, it } from 'vitest'
import { checkSeam, decodePng, encodePng } from '../scripts/seam-check.mjs'

const SURFACE: [number, number, number] = [44, 44, 46]
const PAGE: [number, number, number] = [15, 17, 21]

function image(width: number, height: number, painter: (x: number, y: number) => [number, number, number]): Buffer {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = painter(x, y)
      const index = (y * width + x) * 4
      rgba[index] = r
      rgba[index + 1] = g
      rgba[index + 2] = b
      rgba[index + 3] = 255
    }
  }
  return rgba
}

describe('seam pixel checker', () => {
  it('round-trips a PNG through encode/decode', () => {
    const rgba = image(8, 4, () => SURFACE)
    const decoded = decodePng(encodePng(8, 4, rgba))
    expect(decoded.width).toBe(8)
    expect(decoded.height).toBe(4)
    expect([...decoded.rgba.subarray(0, 4)]).toEqual([...SURFACE, 255])
  })

  it('accepts a clean junction', () => {
    const clean = image(60, 20, () => SURFACE)
    const result = checkSeam(decodePng(encodePng(60, 20, clean)), { x: 0, y: 10, w: 60, page: PAGE, surface: SURFACE })
    expect(result.failures).toEqual([])
  })

  it('rejects a page-background crescent at a corner', () => {
    const bad = image(60, 20, (x, y) => (x < 4 && y >= 8 && y <= 12 ? PAGE : SURFACE))
    const result = checkSeam(decodePng(encodePng(60, 20, bad)), { x: 0, y: 10, w: 60, page: PAGE, surface: SURFACE })
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures.join(' ')).toMatch(/page-background pixel/)
  })


  it('rejects a positive layout gap between dock bottom and card top', () => {
    const clean = image(60, 20, () => SURFACE)
    const result = checkSeam(decodePng(encodePng(60, 20, clean)), { x: 0, y: 10, w: 60, page: PAGE, surface: SURFACE, dockBottom: 14 })
    expect(result.failures.some((failure) => failure.includes('positive gap'))).toBe(true)
    const overlapping = checkSeam(decodePng(encodePng(60, 20, clean)), { x: 0, y: 10, w: 60, page: PAGE, surface: SURFACE, dockBottom: 8 })
    expect(overlapping.failures).toEqual([])
  })

  it('rejects a dark hairline across the seam', () => {
    const bad = image(60, 20, (x, y) => (y === 10 && x > 10 && x < 40 ? [20, 22, 26] : SURFACE))
    const result = checkSeam(decodePng(encodePng(60, 20, bad)), { x: 0, y: 10, w: 60, page: [5, 5, 5], surface: SURFACE })
    expect(result.failures.some((failure) => failure.includes('dark line pixel'))).toBe(true)
  })
})
