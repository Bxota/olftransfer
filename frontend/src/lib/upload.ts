// Helper d'upload commun (single + multipart) partagé entre HomePage et RequestDropPage.
// Apporte : retry par part avec backoff (#1), reprise serveur (#2),
// parallélisme des parts (#3) et génération batch des URLs presignées (#4).

import { runWithConcurrency } from './utils'

export const CHUNK_SIZE = 100 * 1024 * 1024 // 100 Mo par partie
export const UPLOAD_CONCURRENCY = 3
const PART_RETRIES = 4 // 1 essai + 4 reprises

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

function putXhr(
  url: string,
  body: Blob,
  headers: Record<string, string> | undefined,
  onProgress?: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    if (headers) for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded) }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Erreur réseau'))
    xhr.send(body)
  })
}

// PUT avec retry + backoff exponentiel. `refreshUrl` permet de regénérer une URL
// presignée expirée avant une nouvelle tentative (uploads longs).
async function putWithRetry(
  initialUrl: string,
  body: Blob,
  headers: Record<string, string> | undefined,
  onProgress: ((loaded: number) => void) | undefined,
  label: string,
  refreshUrl?: () => Promise<string>,
): Promise<void> {
  let url = initialUrl
  let lastErr: unknown
  for (let attempt = 0; attempt <= PART_RETRIES; attempt++) {
    try {
      onProgress?.(0) // reset la progression de cet essai
      return await putXhr(url, body, headers, onProgress)
    } catch (e) {
      lastErr = e
      if (attempt < PART_RETRIES) {
        await delay(500 * 2 ** attempt)
        if (refreshUrl) { try { url = await refreshUrl() } catch { /* on garde l'ancienne URL */ } }
      }
    }
  }
  throw new Error(`${label} : échec après ${PART_RETRIES + 1} tentatives (${lastErr})`)
}

export interface MultipartEndpoints {
  /** Parties déjà présentes côté serveur (source de vérité pour la reprise). */
  listParts(fileId: string, uploadId: string): Promise<number[]>
  /** URLs presignées pour les parties demandées (batch). */
  partUrls(fileId: string, uploadId: string, partNumbers: number[]): Promise<Record<number, string>>
  /** Finalise l'upload multipart. */
  complete(fileId: string, uploadId: string): Promise<void>
}

export interface MultipartHooks {
  /** Progression en octets (agrège les parts parallèles). */
  onProgress?: (loadedBytes: number, totalBytes: number) => void
  /** Appelé après chaque part réussie (persistance de session locale). */
  onPartComplete?: (completedParts: number[]) => void
  /** Parties déjà connues localement (session), fusionnées avec la vérité serveur. */
  localCompleted?: number[]
}

export async function uploadMultipart(
  file: File,
  fileId: string,
  uploadId: string,
  ep: MultipartEndpoints,
  hooks: MultipartHooks = {},
): Promise<void> {
  const totalParts = Math.ceil(file.size / CHUNK_SIZE)
  const partSize = (n: number) => Math.min(CHUNK_SIZE, file.size - (n - 1) * CHUNK_SIZE)

  // #2 reprise : union de la session locale et de la vérité serveur.
  let serverParts: number[] = []
  try { serverParts = await ep.listParts(fileId, uploadId) } catch { /* non bloquant */ }
  const done = new Set<number>([...(hooks.localCompleted ?? []), ...serverParts])
  let completedParts = [...done].sort((a, b) => a - b)

  const remaining: number[] = []
  for (let n = 1; n <= totalParts; n++) if (!done.has(n)) remaining.push(n)

  // Progression par octets (les parts terminées comptent pour leur taille pleine).
  const loadedByPart: Record<number, number> = {}
  completedParts.forEach(n => { loadedByPart[n] = partSize(n) })
  const report = () => {
    if (!hooks.onProgress) return
    const loaded = Object.values(loadedByPart).reduce((a, b) => a + b, 0)
    hooks.onProgress(loaded, file.size)
  }
  report()

  if (remaining.length > 0) {
    // #4 batch : toutes les URLs presignées en un seul appel.
    const urls = await ep.partUrls(fileId, uploadId, remaining)
    const tasks = remaining.map(n => async () => {
      const start = (n - 1) * CHUNK_SIZE
      await putWithRetry(
        urls[n],
        file.slice(start, start + CHUNK_SIZE),
        undefined,
        loaded => { loadedByPart[n] = loaded; report() },
        `Partie ${n}`,
        async () => (await ep.partUrls(fileId, uploadId, [n]))[n],
      )
      loadedByPart[n] = partSize(n)
      completedParts = [...completedParts, n].sort((a, b) => a - b)
      hooks.onPartComplete?.(completedParts)
      report()
    })
    // #3 parallélisme
    await runWithConcurrency(tasks, UPLOAD_CONCURRENCY)
  }

  await ep.complete(fileId, uploadId)
}

export async function uploadSingle(
  file: File,
  url: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  const headers = file.type ? { 'Content-Type': file.type } : undefined
  await putWithRetry(url, file, headers, loaded => onProgress?.(loaded, file.size), 'Upload')
}
