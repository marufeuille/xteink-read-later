const EMPTY_CHECKSUMS: R2Checksums = {
  toJSON() {
    return {}
  },
}

type StoredObject = {
  readonly bytes: Uint8Array
  readonly uploaded: Date
  readonly customMetadata?: Record<string, string>
}

export type FakeR2Bucket = R2Bucket & {
  failNextPut(key: string): void
  putOrder(): readonly string[]
}

export function createFakeR2Bucket(): FakeR2Bucket {
  const objects = new Map<string, StoredObject>()
  const order: string[] = []
  const failing = new Set<string>()
  let uploadedTick = Date.UTC(2026, 0, 1)

  function toBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Uint8Array {
    if (value === null) {
      return new Uint8Array()
    }
    if (typeof value === 'string') {
      return new TextEncoder().encode(value)
    }
    if (value instanceof Uint8Array) {
      return value
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value)
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    }
    throw new Error('unsupported R2 put body')
  }

  function objectHead(key: string, stored: StoredObject, includeMeta: boolean): R2Object {
    return {
      key,
      version: '1',
      size: stored.bytes.byteLength,
      etag: 'etag',
      httpEtag: '"etag"',
      checksums: EMPTY_CHECKSUMS,
      uploaded: stored.uploaded,
      storageClass: 'Standard',
      ...(includeMeta && stored.customMetadata !== undefined
        ? { customMetadata: stored.customMetadata }
        : {}),
      writeHttpMetadata() {},
    } as unknown as R2Object
  }

  function objectBody(key: string, stored: StoredObject): R2ObjectBody {
    return {
      ...objectHead(key, stored, true),
      get body(): ReadableStream {
        return new Blob([stored.bytes]).stream()
      },
      get bodyUsed() {
        return false
      },
      arrayBuffer: async () => stored.bytes.slice().buffer,
      bytes: async () => stored.bytes.slice(),
      text: async () => new TextDecoder().decode(stored.bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(stored.bytes)) as T,
      blob: async () => new Blob([stored.bytes]),
    } as unknown as R2ObjectBody
  }

  const bucket: FakeR2Bucket = {
    async head(key) {
      const stored = objects.get(key)
      return stored === undefined ? null : objectHead(key, stored, true)
    },
    async get(key) {
      const stored = objects.get(key)
      return stored === undefined ? null : objectBody(key, stored)
    },
    async put(key, value, options) {
      if (failing.has(key)) {
        failing.delete(key)
        throw new Error(`R2 put failed: ${key}`)
      }
      uploadedTick += 1000
      const stored: StoredObject = {
        bytes: toBytes(value),
        uploaded: new Date(uploadedTick),
        ...(options?.customMetadata !== undefined ? { customMetadata: options.customMetadata } : {}),
      }
      objects.set(key, stored)
      order.push(key)
      return objectHead(key, stored, true)
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key)
      }
    },
    async list(options) {
      const prefix = options?.prefix ?? ''
      const cursor = options?.cursor
      const limit = options?.limit ?? 1000
      const includeMeta = options?.include?.includes('customMetadata') === true
      const all = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = cursor !== undefined && cursor.length > 0 ? Number(cursor) : 0
      const slice = all.slice(start, start + limit)
      const next = start + slice.length
      const listed: R2Object[] = []
      for (const key of slice) {
        const stored = objects.get(key)
        if (stored !== undefined) {
          listed.push(objectHead(key, stored, includeMeta))
        }
      }
      if (next < all.length) {
        return {
          objects: listed,
          truncated: true,
          cursor: String(next),
          delimitedPrefixes: [],
        }
      }
      return {
        objects: listed,
        truncated: false,
        delimitedPrefixes: [],
      }
    },
    createMultipartUpload() {
      throw new Error('multipart not implemented')
    },
    resumeMultipartUpload() {
      throw new Error('multipart not implemented')
    },
    failNextPut(key) {
      failing.add(key)
    },
    putOrder() {
      return order
    },
  }

  return bucket
}
