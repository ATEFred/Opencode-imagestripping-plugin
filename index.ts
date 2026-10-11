// Intentionally zero plugin-SDK imports: local plugins discovered under
// ~/.config/opencode/plugins cannot always resolve the "@opencode/plugin"
// package, and the plain `export default { id, setup }` shape loads without
// it. Only node built-ins are used.
import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * image-stripping
 *
 * Base64 images in session history are re-sent on every model request. A few
 * screenshots can push the raw HTTP body past provider/gateway byte limits
 * ("request body is too large", 413) long before token-based auto-compaction
 * notices anything — and once that happens the session is stuck, because even
 * /compact ships the same oversized transcript.
 *
 * This plugin treats images as one-shot observations:
 *  - The current turn's images are sent untouched (the model still needs them).
 *  - Images from older turns are removed from the OUTGOING request only
 *    (persisted history, the UI, exports, and revert are all unaffected).
 *  - Each stripped image is preserved as an immutable, content-hashed file in
 *    a local store, and its slot in the request is replaced with a text
 *    placeholder that names the saved path, so the model can `read` the image
 *    again at any point, much later.
 *  - Compaction requests drop all images, so summaries never fail on size.
 */

interface PluginOptions {
  /** Store directory for preserved image copies. */
  dir?: string
  /** Keep images from the last user turn intact. Default: true. */
  keepCurrentTurn?: boolean
  /** Only strip image parts whose decoded size is at least this many bytes. Default: 0. */
  minBytes?: number
  /** Delete stored copies older than this many days on startup. 0 disables. Default: 30. */
  pruneDays?: number
  /** Append strip activity to <dir>/plugin-debug.log. Default: false. */
  debug?: boolean
}

const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/tiff": ".tiff",
}

function extFor(mime: string, filename?: string): string {
  const byMime = IMAGE_EXT[mime.toLowerCase()]
  if (byMime) return byMime
  const m = /\.([a-z0-9]+)$/i.exec(filename ?? "")
  return m ? `.${m[1].toLowerCase()}` : ".img"
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/=\s]{256,}$/.test(value)
}

interface ImagePayload {
  mime: string
  b64: string
  filename?: string
}

function fromDataUrl(value: unknown): ImagePayload | undefined {
  if (typeof value !== "string") return undefined
  const m = DATA_URL.exec(value)
  if (!m) return undefined
  if (!m[1].toLowerCase().startsWith("image/")) return undefined
  return { mime: m[1], b64: m[2] }
}

/** Recognize an image in any of the shapes assembled model messages use. */
function decodeImagePart(part: any): ImagePayload | undefined {
  if (!part || typeof part !== "object") return undefined
  switch (part.type) {
    case "file": {
      const fromData = fromDataUrl(part.data) ?? fromDataUrl(part.url) ?? fromDataUrl(part.uri)
      if (fromData) return { ...fromData, filename: part.filename ?? part.name }
      const mime = String(part.mediaType ?? part.mime ?? "").toLowerCase()
      if (mime.startsWith("image/") && typeof part.data === "string" && looksLikeBase64(part.data))
        return { mime, b64: part.data.replace(/\s+/g, ""), filename: part.filename ?? part.name }
      if (mime.startsWith("image/") && looksLikeBase64(String(part.url ?? part.uri ?? "")))
        return { mime, b64: String(part.url ?? part.uri).replace(/\s+/g, ""), filename: part.filename ?? part.name }
      return undefined
    }
    case "image": {
      const fromImage = fromDataUrl(part.image)
      if (fromImage) return fromImage
      const source = part.source
      if (source?.type === "base64" && typeof source.data === "string" && looksLikeBase64(source.data)) {
        const mime = String(source.media_type ?? source.mediaType ?? "image/png").toLowerCase()
        return { mime, b64: source.data.replace(/\s+/g, "") }
      }
      return undefined
    }
    case "image_url": {
      const url = part.image_url?.url ?? part.url
      const fromUrl = fromDataUrl(url)
      if (fromUrl) return fromUrl
      if (typeof url === "string" && url.startsWith("data:") && looksLikeBase64(url.slice(url.indexOf(",") + 1))) {
        const mime = url.slice(5, url.indexOf(";")).toLowerCase() || "image/png"
        if (mime.startsWith("image/")) return { mime, b64: url.slice(url.indexOf(",") + 1) }
      }
      return undefined
    }
    case "media": {
      // OpenCode assembled format: { type: "media", media: { source: { type: "base64", data, mediaType } }, filename }
      const source = part.media?.source
      if (source?.type === "base64" && typeof source.data === "string") {
        const du = fromDataUrl(source.data)
        if (du) return { ...du, filename: part.filename ?? du.filename }
        const mime = String(source.mediaType ?? source.media_type ?? "").toLowerCase()
        if (mime.startsWith("image/") && looksLikeBase64(source.data))
          return { mime, b64: source.data.replace(/\s+/g, ""), filename: part.filename }
      }
      const du2 = fromDataUrl(part.media?.url) ?? fromDataUrl(part.media?.data)
      if (du2) return { ...du2, filename: part.filename }
      const mime2 = String(part.media?.mediaType ?? "").toLowerCase()
      if (mime2.startsWith("image/") && typeof part.media?.data === "string" && looksLikeBase64(part.media.data))
        return { mime: mime2, b64: part.media.data.replace(/\s+/g, ""), filename: part.filename }
      return undefined
    }
    default:
      return undefined
  }
}

function decodedBytes(b64: string): number {
  const clean = b64.length % 4 === 0 ? b64 : b64.replace(/=+$/, "")
  return Math.floor((clean.length * 3) / 4)
}

function makeSaver(dir: string) {
  let warned = false
  return (mime: string, b64: string, filename?: string): string | undefined => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const hash = createHash("sha256").update(b64).digest("hex").slice(0, 24)
      const path = join(dir, hash + extFor(mime, filename))
      if (!existsSync(path)) {
        writeFileSync(path, Buffer.from(b64, "base64"))
        chmodSync(path, 0o600)
      }
      return path
    } catch (err) {
      if (!warned) {
        console.warn(`image-stripping: could not save image copy to ${dir}: ${err}`)
        warned = true
      }
      return undefined
    }
  }
}

type Saver = ReturnType<typeof makeSaver>

function placeholderText(img: ImagePayload, bytes: number, saved: string | undefined): string {
  const name = img.filename ? `"${img.filename}", ` : ""
  const where = saved
    ? `A copy is preserved at ${saved} — use the read tool on that path to view the image again.`
    : `No copy was saved.`
  return `[image stripped from history to keep the request within provider size limits: ${name}${img.mime}, ~${humanSize(bytes)}. ${where}]`
}

interface StripResult {
  count: number
  bytes: number
}

/** Replace image entries inside a tool-result's result/output without breaking tool-call pairing. */
function cleanToolResult(part: any, minBytes: number, save: Saver, out: StripResult): void {
  for (const key of ["output", "result"] as const) {
    const container = part[key]
    if (!container || typeof container !== "object") continue
    if (container.type === "content" && Array.isArray(container.value)) {
      container.value = container.value.map((entry: any) => {
        const inner = decodeImagePart(entry)
        if (!inner) return entry
        const bytes = decodedBytes(inner.b64)
        if (bytes < minBytes) return entry
        const saved = save(inner.mime, inner.b64, inner.filename)
        out.count += 1
        out.bytes += bytes
        return { type: "text", text: placeholderText(inner, bytes, saved) }
      })
      continue
    }
    const direct = decodeImagePart(container)
    if (direct) {
      const bytes = decodedBytes(direct.b64)
      if (bytes < minBytes) return
      const saved = save(direct.mime, direct.b64, direct.filename)
      out.count += 1
      out.bytes += bytes
      part[key] = { type: "text", value: placeholderText(direct, bytes, saved) }
      continue
    }
    if (container.type === "text" && typeof container.value === "string") {
      const du = fromDataUrl(container.value)
      if (!du) continue
      const bytes = decodedBytes(du.b64)
      if (bytes < minBytes) continue
      const saved = save(du.mime, du.b64)
      out.count += 1
      out.bytes += bytes
      container.value = placeholderText(du, bytes, saved)
    }
  }
  if (typeof part.content === "string") {
    const du = fromDataUrl(part.content)
    if (du) {
      const bytes = decodedBytes(du.b64)
      if (bytes < minBytes) return
      const saved = save(du.mime, du.b64)
      out.count += 1
      out.bytes += bytes
      part.content = placeholderText(du, bytes, saved)
    }
  }
}

function stripMessages(
  messages: readonly any[],
  opts: { keepCurrentTurn: boolean; minBytes: number; save: Saver },
): StripResult {
  const out: StripResult = { count: 0, bytes: 0 }
  let cutoff = messages.length
  if (opts.keepCurrentTurn) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const role = messages[i]?.role
      if (role === "user") {
        cutoff = i
        break
      }
    }
  }
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]
    const parts = Array.isArray(msg?.content) ? msg.content : Array.isArray(msg?.parts) ? msg.parts : undefined
    if (!parts) continue
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j]
      if (!part || typeof part !== "object") continue
      if (part.type === "tool-result" || part.toolCallId) {
        cleanToolResult(part, opts.minBytes, opts.save, out)
        continue
      }
      const img = decodeImagePart(part)
      if (!img) continue
      const bytes = decodedBytes(img.b64)
      if (bytes < opts.minBytes) continue
      const saved = opts.save(img.mime, img.b64, img.filename)
      out.count += 1
      out.bytes += bytes
      parts[j] = { type: "text", text: placeholderText(img, bytes, saved) }
    }
  }
  return out
}

export default {
  id: "image-stripping",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as PluginOptions
    const dir =
      opts.dir ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode", "image-stripping", "images")
    const keepCurrentTurn = opts.keepCurrentTurn !== false
    const minBytes = typeof opts.minBytes === "number" ? opts.minBytes : 0
    const pruneDays = typeof opts.pruneDays === "number" ? opts.pruneDays : 30
    const save = makeSaver(dir)

    if (pruneDays > 0) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const cutoff = Date.now() - pruneDays * 24 * 60 * 60 * 1000
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry)
          try {
            if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
          } catch {}
        }
      } catch {}
    }

    const debug = opts.debug === true
    let debugFile: string | undefined
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      debugFile = join(dir, "plugin-debug.log")
    } catch {}
    const dlog = (s: string) => {
      if (!debug || !debugFile) return
      try {
        appendFileSync(debugFile, `${new Date().toISOString()} ${s}\n`)
      } catch {}
    }
    dlog(`setup ok; dir=${dir} keepCurrentTurn=${keepCurrentTurn} minBytes=${minBytes} pruneDays=${pruneDays}`)

    const run = (label: string, messages: unknown, keep: boolean) => {
      if (!Array.isArray(messages)) return
      const { count, bytes } = stripMessages(messages, { keepCurrentTurn: keep, minBytes, save })
      if (count > 0) {
        console.log(
          `image-stripping: ${label}: removed ${count} stale image part(s), ~${humanSize(bytes)} of base64, from the outgoing request; copies preserved under ${dir}`,
        )
        dlog(`${label}: stripped ${count} image part(s), ~${humanSize(bytes)}`)
      }
    }

    // Agent loop (including tool-driven continuations): keep the current turn's
    // images, strip older ones. Deterministic, so wire history stays stable and
    // provider prompt caching still works.
    await ctx.session.hook("context", (event: any) => run("context", event.messages, keepCurrentTurn))

    // Checkpoint summaries: the transcript being summarized is textual output,
    // images add nothing but bytes — this is what makes /compact survive.
    await ctx.session.hook("compaction", (event: any) => run("compaction", event.messages, false))

    // Transient generate calls: treat their own prompt as the current turn.
    await ctx.session.hook("generate", (event: any) => run("generate", event.messages, true))
  },
}
