export function formatBytes(b: number): string {
  if (b === 0) return '0 o'
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i]
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function getExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i) : ''
}

export function getStem(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

export type FileCategory = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'code' | 'other'

export function getFileCategory(file: File): FileCategory {
  const t = file.type
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  if (t === 'application/pdf') return 'pdf'
  if (/\.(js|jsx|ts|tsx|py|sh|bash|zsh|rb|go|rs|java|c|cpp|h|hpp|cs|php|swift|kt|scala|lua|r|sql|html|css|scss|sass|less|json|xml|yaml|yml|toml|dockerfile)$/i.test(file.name))
    return 'code'
  if (t.startsWith('text/') || /\.(txt|md|csv|log)$/i.test(file.name))
    return 'text'
  return 'other'
}
