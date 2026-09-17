#!/usr/bin/env node
/**
 * Seam pixel checker: decodes a PNG and proves a dock/composer junction has no
 * page-background cutouts (black crescents) and no hairline distinct from the
 * shared surface.
 *
 * CLI:
 *   node scripts/seam-check.mjs <png> --x <left> --w <width> --y <seamY>
 *        [--page 15,17,21] [--surface 44,44,46] [--tolerance 14]
 */

import { inflateSync, deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** Build a minimal 8-bit RGBA PNG from raw pixels (RGB rows accepted). */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4)
    raw[row] = 0
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4)
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode an 8-bit truecolor PNG (RGB or RGBA) into an RGBA buffer. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('seam-check: not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      if (data[8] !== 8) throw new Error('seam-check: only 8-bit PNGs are supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`seam-check: unsupported color type ${String(colorType)}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + a) & 0xff
      else if (filter === 2) line[x] = (line[x] + b) & 0xff
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff
    }
    prev = line
    for (let x = 0; x < width; x += 1) {
      out[(y * width + x) * 4] = line[x * channels]
      out[(y * width + x) * 4 + 1] = line[x * channels + 1]
      out[(y * width + x) * 4 + 2] = line[x * channels + 2]
      out[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
  }
  return { width, height, rgba: out }
}

function close(a, b, tolerance) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance
}

/**
 * Inspect a junction band.
 * @returns { failures: string[], stats: { pagePixels: number, bandSamples: number } }
 */
export function checkSeam(image, options) {
  const { x, y, w } = options
  const page = options.page ?? [15, 17, 21]
  const surface = options.surface ?? [44, 44, 46]
  const tolerance = options.tolerance ?? 14
  const failures = []
  let pagePixels = 0
  let bandSamples = 0
  // Positive layout gap: the dock's bottom edge must reach or pass the card
  // top. A dock bottom above the card top leaves page background between them.
  if (typeof options.dockBottom === 'number' && options.dockBottom < y) {
    failures.push(`layout: positive gap of ${String(y - options.dockBottom)}px between the dock bottom and the composer card top`)
  }
  const pixel = (px, py) => {
    const index = (py * image.width + px) * 4
    return [image.rgba[index], image.rgba[index + 1], image.rgba[index + 2], image.rgba[index + 3]]
  }
  const band = (fromX, toX, fromY, toY, label) => {
    for (let py = fromY; py <= toY; py += 1) {
      for (let px = fromX; px <= toX; px += 1) {
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue
        bandSamples += 1
        const value = pixel(px, py)
        if (close(value, page, tolerance)) {
          pagePixels += 1
          if (failures.length < 6) failures.push(`${label}: page-background pixel at (${String(px)},${String(py)}) rgba(${value.join(',')})`)
        }
      }
    }
  }
  // Full width across the seam, plus both corner junctions.
  band(x, x + w - 1, y - 3, y + 3, 'band')
  band(x, x + 5, y - 4, y + 4, 'left corner')
  band(x + w - 6, x + w - 1, y - 4, y + 4, 'right corner')
  // A hairline distinct from both the surface and the page would sit between
  // them; the page check above already rejects near-black crescents, and this
  // rejects any unexpected dark line across the seam.
  for (let px = x; px < x + w; px += 1) {
    for (let py = y - 3; py <= y + 3; py += 1) {
      const value = pixel(px, py)
      const darkerThanPage = value[0] < page[0] - tolerance && value[1] < page[1] - tolerance && value[2] < page[2] - tolerance
      const darkerThanSurface = value[0] < surface[0] - tolerance && value[1] < surface[1] - tolerance && value[2] < surface[2] - tolerance
      if (darkerThanPage || darkerThanSurface) {
        if (failures.length < 8) failures.push(`band: dark line pixel at (${String(px)},${String(py)}) rgba(${value.join(',')})`)
      }
    }
  }
  return { failures, stats: { pagePixels, bandSamples } }
}


function pixelAt(image, px, py) {
  const index = (py * image.width + px) * 4
  return [image.rgba[index], image.rgba[index + 1], image.rgba[index + 2]]
}

function isBackgroundish(value, page, tolerance) {
  return Math.abs(value[0] - page[0]) <= tolerance
    && Math.abs(value[1] - page[1]) <= tolerance
    && Math.abs(value[2] - page[2]) <= tolerance
}

/**
 * Compare the vertical edge profile of the plan surface against the composer
 * surface on both sides. A one-pixel protrusion, outward shadow, notch, or
 * horizontal shift at either straight edge fails.
 *
 * @param options.leftEdge - expected x of the first surface pixel on the left.
 * @param options.rightEdge - expected x of the last surface pixel on the right.
 * @param options.planY - a row inside the plan surface's straight side.
 * @param options.inputY - a row inside the composer surface's straight side.
 */
export function checkEdgeProfiles(image, options) {
  const page = options.page ?? [15, 17, 21]
  const surface = options.surface ?? [44, 44, 46]
  const tolerance = options.tolerance ?? 14
  const span = options.span ?? 2
  const failures = []

  const checkSide = (side, y, region) => {
    const exteriorX = side === 'left' ? options.leftEdge - 1 : options.rightEdge + 1
    const interiorX = side === 'left' ? options.leftEdge : options.rightEdge
    for (let dy = -span; dy <= span; dy += 1) {
      const py = y + dy
      if (py < 0 || py >= image.height) continue
      const exterior = pixelAt(image, exteriorX, py)
      if (!close(exterior, page, tolerance)) {
        failures.push(`${region} ${side}: protrudes with rgba(${exterior.join(',')}) at (${String(exteriorX)},${String(py)}) instead of page background`)
        return
      }
      const interior = pixelAt(image, interiorX, py)
      if (!close(interior, surface, tolerance)) {
        failures.push(`${region} ${side}: interior at (${String(interiorX)},${String(py)}) is rgba(${interior.join(',')}) instead of the shared surface`)
        return
      }
    }
  }

  checkSide('left', options.planY, 'plan')
  checkSide('right', options.planY, 'plan')
  checkSide('left', options.inputY, 'composer')
  checkSide('right', options.inputY, 'composer')

  // Horizontal shift: the first non-background column must coincide between the
  // plan and composer rows on each side.
  const edgeOf = (side, y) => {
    for (let px = side === 'left' ? options.leftEdge - 3 : options.rightEdge + 3;
      side === 'left' ? px <= options.leftEdge + 3 : px >= options.rightEdge - 3;
      px += side === 'left' ? 1 : -1) {
      if (!isBackgroundish(pixelAt(image, px, y), page, tolerance)) return px
    }
    return null
  }
  for (const side of ['left', 'right']) {
    const planEdge = edgeOf(side, options.planY)
    const inputEdge = edgeOf(side, options.inputY)
    if (planEdge !== null && inputEdge !== null && planEdge !== inputEdge) {
      failures.push(`${side}: horizontal edge shift between plan (x${String(planEdge)}) and composer (x${String(inputEdge)})`)
    }
  }
  return { failures }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (invokedDirectly) {
  const [png, ...rest] = process.argv.slice(2)
  const arg = (name, fallback) => {
    const index = rest.indexOf(name)
    return index >= 0 ? rest[index + 1] : fallback
  }
  const numbers = (value, fallback) => (typeof value === 'string' ? value.split(',').map(Number) : fallback)
  const image = decodePng(readFileSync(png))
  const edgeLeft = rest.indexOf('--edge-left') >= 0 ? Number(rest[rest.indexOf('--edge-left') + 1]) : undefined
  const edgeRight = rest.indexOf('--edge-right') >= 0 ? Number(rest[rest.indexOf('--edge-right') + 1]) : undefined
  const planY = rest.indexOf('--plan-y') >= 0 ? Number(rest[rest.indexOf('--plan-y') + 1]) : undefined
  const inputY = rest.indexOf('--input-y') >= 0 ? Number(rest[rest.indexOf('--input-y') + 1]) : undefined
  if (edgeLeft !== undefined && edgeRight !== undefined && planY !== undefined && inputY !== undefined) {
    const edge = checkEdgeProfiles(image, {
      leftEdge: edgeLeft,
      rightEdge: edgeRight,
      planY,
      inputY,
      page: numbers(arg('--page'), undefined),
      surface: numbers(arg('--surface'), undefined),
      tolerance: Number(arg('--tolerance', '14')),
    })
    if (edge.failures.length > 0) {
      console.log(`seam-check: EDGE FAIL ${png}`)
      for (const failure of edge.failures) console.log(`  ${failure}`)
      process.exitCode = 1
    } else {
      console.log(`seam-check: EDGE PASS ${png} (left x${String(edgeLeft)}, right x${String(edgeRight)})`)
    }
  }
  const result = checkSeam(image, {
    x: Number(arg('--x', '0')),
    y: Number(arg('--y', '0')),
    w: Number(arg('--w', String(image.width))),
    page: numbers(arg('--page'), undefined),
    surface: numbers(arg('--surface'), undefined),
    tolerance: Number(arg('--tolerance', '14')),
    dockBottom: arg('--dock-bottom') === undefined ? undefined : Number(arg('--dock-bottom')),
  })
  console.log(`seam-check: ${result.failures.length === 0 ? 'PASS' : 'FAIL'} ${png} (${String(image.width)}x${String(image.height)}; ${String(result.stats.bandSamples)} samples, ${String(result.stats.pagePixels)} page pixels)`)
  for (const failure of result.failures) console.log(`  ${failure}`)
  if (result.failures.length > 0) process.exitCode = 1
}
