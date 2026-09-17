/** Type surface for the seam pixel checker. */

export function encodePng(width: number, height: number, rgba: Buffer): Buffer
export function decodePng(buffer: Buffer): { width: number; height: number; rgba: Buffer }
export function checkSeam(
  image: { width: number; height: number; rgba: Buffer },
  options: {
    x: number
    y: number
    w: number
    page?: number[]
    surface?: number[]
    tolerance?: number
  },
): { failures: string[]; stats: { pagePixels: number; bandSamples: number } }
