const CACHE = 'olfshare-v1'
const IDB_NAME = 'olfshare'
const IDB_STORE = 'pending'

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function storeSharedFiles(files) {
  const id = Date.now().toString()
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(files, id)
    tx.oncomplete = () => resolve(id)
    tx.onerror = () => reject(tx.error)
  })
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData()
          const files = formData.getAll('files')
          const shareId = await storeSharedFiles(files)
          return Response.redirect(`/?share=${shareId}`, 303)
        } catch {
          return Response.redirect('/', 303)
        }
      })()
    )
  }
})

// Allow the app to retrieve shared files
self.addEventListener('message', async event => {
  if (event.data?.type === 'GET_SHARED_FILES') {
    const { shareId } = event.data
    try {
      const db = await openIDB()
      const tx = db.transaction(IDB_STORE, 'readwrite')
      const store = tx.objectStore(IDB_STORE)
      const files = await new Promise((resolve, reject) => {
        const req = store.get(shareId)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      store.delete(shareId)
      event.source.postMessage({ type: 'SHARED_FILES', files: files || [] })
    } catch {
      event.source.postMessage({ type: 'SHARED_FILES', files: [] })
    }
  }
})
