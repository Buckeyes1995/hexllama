// Minimal GGUF v2/v3 header reader. Walks metadata KV pairs and returns the
// model's native context length (any key matching `<arch>.context_length`).
//
// We read at most HEADER_READ_BYTES from the start of the file — large enough
// to hold metadata for any realistic model, small enough to be fast over slow
// disks. Tensor data is never touched.

import { promises as fsPromises } from 'fs'

const MAGIC = Buffer.from('GGUF', 'utf-8')
const HEADER_READ_BYTES = 4 * 1024 * 1024 // 4 MB; covers fat metadata blobs (vocabs)

enum GgufType {
  UINT8 = 0, INT8 = 1, UINT16 = 2, INT16 = 3,
  UINT32 = 4, INT32 = 5, FLOAT32 = 6, BOOL = 7,
  STRING = 8, ARRAY = 9,
  UINT64 = 10, INT64 = 11, FLOAT64 = 12
}

// Cache by absolute path; small invalidation via size+mtime so an edited file
// is re-parsed without an explicit cache bust.
interface CacheEntry { ctx: number | null; size: number; mtimeMs: number }
const cache = new Map<string, CacheEntry>()

class Cursor {
  constructor(public buf: Buffer, public off: number = 0) {}
  u32(): number { const v = this.buf.readUInt32LE(this.off); this.off += 4; return v }
  u64(): number {
    // GGUF uses unsigned 64; JS Number is safe up to 2^53. Realistic ctx values fit.
    const lo = this.buf.readUInt32LE(this.off)
    const hi = this.buf.readUInt32LE(this.off + 4)
    this.off += 8
    return hi * 0x1_0000_0000 + lo
  }
  i32(): number { const v = this.buf.readInt32LE(this.off); this.off += 4; return v }
  i64(): number {
    const lo = this.buf.readUInt32LE(this.off)
    const hi = this.buf.readInt32LE(this.off + 4)
    this.off += 8
    return hi * 0x1_0000_0000 + lo
  }
  f32(): number { const v = this.buf.readFloatLE(this.off); this.off += 4; return v }
  f64(): number { const v = this.buf.readDoubleLE(this.off); this.off += 8; return v }
  u8(): number { return this.buf[this.off++] }
  i8(): number { const v = this.buf.readInt8(this.off); this.off += 1; return v }
  u16(): number { const v = this.buf.readUInt16LE(this.off); this.off += 2; return v }
  i16(): number { const v = this.buf.readInt16LE(this.off); this.off += 2; return v }
  str(): string {
    const len = this.u64()
    const s = this.buf.toString('utf-8', this.off, this.off + len)
    this.off += len
    return s
  }
  skipValue(type: number): void {
    switch (type) {
      case GgufType.UINT8: case GgufType.INT8: case GgufType.BOOL: this.off += 1; return
      case GgufType.UINT16: case GgufType.INT16: this.off += 2; return
      case GgufType.UINT32: case GgufType.INT32: case GgufType.FLOAT32: this.off += 4; return
      case GgufType.UINT64: case GgufType.INT64: case GgufType.FLOAT64: this.off += 8; return
      case GgufType.STRING: { const slen = this.u64(); this.off += slen; return }
      case GgufType.ARRAY: {
        const elemType = this.u32()
        const n = this.u64()
        for (let i = 0; i < n; i++) this.skipValue(elemType)
        return
      }
      default: throw new Error(`Unknown GGUF type ${type}`)
    }
  }
  readNumeric(type: number): number | null {
    switch (type) {
      case GgufType.UINT8: return this.u8()
      case GgufType.INT8: return this.i8()
      case GgufType.UINT16: return this.u16()
      case GgufType.INT16: return this.i16()
      case GgufType.UINT32: return this.u32()
      case GgufType.INT32: return this.i32()
      case GgufType.UINT64: return this.u64()
      case GgufType.INT64: return this.i64()
      case GgufType.FLOAT32: { const v = this.f32(); return Math.round(v) }
      case GgufType.FLOAT64: { const v = this.f64(); return Math.round(v) }
      default: return null
    }
  }
}

async function readNativeContextUncached(filePath: string): Promise<number | null> {
  let fh
  try {
    fh = await fsPromises.open(filePath, 'r')
    const stat = await fh.stat()
    const len = Math.min(HEADER_READ_BYTES, stat.size)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    if (!buf.subarray(0, 4).equals(MAGIC)) return null
    const c = new Cursor(buf, 4)
    const version = c.u32()
    if (version < 2 || version > 3) return null // unfamiliar version
    c.u64() // tensor_count
    const kvCount = c.u64()
    for (let i = 0; i < kvCount; i++) {
      if (c.off >= buf.length - 12) return null // ran past our window
      const key = c.str()
      const type = c.u32()
      if (key.endsWith('.context_length')) return c.readNumeric(type)
      try { c.skipValue(type) } catch { return null }
    }
    return null
  } catch {
    return null
  } finally {
    try { await fh?.close() } catch {}
  }
}

export async function readNativeContext(filePath: string): Promise<number | null> {
  let size = 0, mtimeMs = 0
  try {
    const st = await fsPromises.stat(filePath)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch { return null }
  const hit = cache.get(filePath)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.ctx
  const ctx = await readNativeContextUncached(filePath)
  cache.set(filePath, { ctx, size, mtimeMs })
  return ctx
}
