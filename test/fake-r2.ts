const EMPTY_CHECKSUMS: R2Checksums = {
  toJSON() {
    return {}
  },
}

export function createFakeR2Bucket(): R2Bucket {
  const objects = new Map<string, Uint8Array>()

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

  function objectHead(key: string, bytes: Uint8Array): R2Object {
    return {
      key,
      version: '1',
      size: bytes.byteLength,
      etag: 'etag',
      httpEtag: '"etag"',
      checksums: EMPTY_CHECKSUMS,
      uploaded: new Date(),
      storageClass: 'Standard',
      writeHttpMetadata() {},
    } as unknown as R2Object
  }

  function objectBody(key: string, bytes: Uint8Array): R2ObjectBody {
    return {
      ...objectHead(key, bytes),
      get body(): ReadableStream {
        return new Blob([bytes]).stream()
      },
      get bodyUsed() {
        return false
      },
      arrayBuffer: async () => bytes.slice().buffer,
      bytes: async () => bytes.slice(),
      text: async () => new TextDecoder().decode(bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
      blob: async () => new Blob([bytes]),
    } as unknown as R2ObjectBody
  }

  const bucket: R2Bucket = {
    async head(key) {
      const bytes = objects.get(key)
      return bytes === undefined ? null : objectHead(key, bytes)
    },
    async get(key) {
      const bytes = objects.get(key)
      return bytes === undefined ? null : objectBody(key, bytes)
    },
    async put(key, value) {
      const bytes = toBytes(value)
      objects.set(key, bytes)
      return objectHead(key, bytes)
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
      const all = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = cursor !== undefined && cursor.length > 0 ? Number(cursor) : 0
      const slice = all.slice(start, start + limit)
      const next = start + slice.length
      const listed = slice.map((key) => objectHead(key, objects.get(key) ?? new Uint8Array()))
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
  }

  return bucket
}
