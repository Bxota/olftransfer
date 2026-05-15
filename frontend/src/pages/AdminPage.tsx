import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { formatBytes } from '../lib/utils'
import UserIcon from '../icons/user-icon'
import UserCheckIcon from '../icons/user-check-icon'

interface UserItem {
  id: string
  email: string
  is_admin: boolean
  is_trusted: boolean
  created_at: string
  storage_quota_bytes: number
}

interface LogItem {
  key: string
  size: number
  last_modified: string
}

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export default function AdminPage() {
  const navigate = useNavigate()
  const { setUser } = useAuth()

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [inviteSuccess, setInviteSuccess] = useState<{ msg: string; url?: string } | null>(null)

  const [users, setUsers] = useState<UserItem[]>([])
  const [stats, setStats] = useState<any>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [logs, setLogs] = useState<LogItem[]>([])
  const [logsUnavailable, setLogsUnavailable] = useState(false)
  const [logViewer, setLogViewer] = useState<{ key: string; content: string } | null>(null)

  useEffect(() => {
    loadUsers()
    loadStats()
    loadLogs()
  }, [])

  async function loadUsers() {
    const res = await fetch('/admin/users')
    if (!res.ok) return
    setUsers(await res.json())
  }

  async function loadStats(refresh = false) {
    setStatsLoading(true)
    const res = await fetch('/admin/stats' + (refresh ? '?refresh=true' : ''))
    setStatsLoading(false)
    if (!res.ok) return
    setStats(await res.json())
  }

  async function loadLogs() {
    const res = await fetch('/admin/logs')
    if (res.status === 503) { setLogsUnavailable(true); return }
    if (!res.ok) return
    setLogs(await res.json())
  }

  async function openLog(key: string) {
    setLogViewer({ key, content: 'Chargement…' })
    const res = await fetch(`/admin/logs/content?key=${encodeURIComponent(key)}`)
    if (!res.ok) { setLogViewer({ key, content: 'Erreur lors du chargement du fichier.' }); return }
    const data = await res.json()
    setLogViewer({ key, content: data.content || '(fichier vide)' })
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault()
    setInviteError('')
    setInviteSuccess(null)
    setInviteLoading(true)
    try {
      const res = await fetch('/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail }),
      })
      const data = await res.json()
      if (res.ok) {
        if (data.smtp_error) {
          setInviteSuccess({ msg: 'Email non envoyé (SMTP non configuré). Partage ce lien manuellement :', url: data.invite_url })
        } else {
          setInviteSuccess({ msg: `Invitation envoyée à ${inviteEmail} !` })
        }
        setInviteEmail('')
        loadUsers()
      } else {
        setInviteError(data.detail)
      }
    } catch {
      setInviteError('Erreur réseau.')
    } finally {
      setInviteLoading(false)
    }
  }

  async function handleQuotaEdit(u: UserItem) {
    const currentGb = Math.round(u.storage_quota_bytes / 1073741824)
    const input = prompt(`Quota pour cet utilisateur (en Go, actuellement ${currentGb} Go) :`, String(currentGb))
    if (input === null) return
    const gb = parseFloat(input)
    if (isNaN(gb) || gb < 0) { alert('Valeur invalide'); return }
    const res = await fetch(`/admin/users/${u.id}/quota`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage_quota_bytes: Math.round(gb * 1073741824) }),
    })
    if (res.ok) loadUsers()
    else alert('Erreur lors de la mise à jour du quota')
  }

  async function handleTrustedToggle(u: UserItem) {
    const res = await fetch(`/admin/users/${u.id}/trusted`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_trusted: !u.is_trusted }),
    })
    if (res.ok) loadUsers()
  }

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' })
    setUser(null)
    navigate('/login')
  }

  return (
    <>
      <header className="header">
        <Link to="/" className="logo">
          <div className="logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <span className="logo-name">OlfTransfer</span>
        </Link>
        <div className="header-actions">
          <Link to="/" className="btn btn-ghost btn-sm">Retour</Link>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Déconnexion</button>
        </div>
      </header>

      <main className="page">
        <div className="page-admin">
          <div className="admin-grid">
            {/* Invite */}
            <div className="card">
              <div className="card-body">
                <p className="section-label">Inviter un utilisateur</p>
                <form onSubmit={handleInvite}>
                  <div className="field">
                    <label htmlFor="inviteEmail">Adresse email</label>
                    <input
                      id="inviteEmail"
                      type="email"
                      placeholder="ami@exemple.com"
                      autoFocus
                      value={inviteEmail}
                      onChange={e => setInviteEmail(e.target.value)}
                    />
                  </div>
                  {inviteError && <div className="alert alert-error mt-3">{inviteError}</div>}
                  {inviteSuccess && (
                    <div className="mt-3">
                      <div className="alert alert-success">{inviteSuccess.msg}</div>
                      {inviteSuccess.url && (
                        <div className="share-box mt-3">
                          <span className="share-link">{inviteSuccess.url}</span>
                          <button
                            type="button"
                            className="copy-btn"
                            onClick={() => {
                              navigator.clipboard.writeText(inviteSuccess.url!)
                            }}
                          >
                            Copier
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <button type="submit" className="btn btn-primary btn-full mt-4" disabled={inviteLoading}>
                    {inviteLoading ? 'Envoi…' : "Envoyer l'invitation"}
                  </button>
                </form>
              </div>
            </div>

            {/* Users */}
            <div className="card">
              <div className="card-body">
                <p className="section-label">Utilisateurs</p>
                <ul className="file-list" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {users.length === 0 && (
                    <li className="text-subtext" style={{ padding: '12px 0' }}>Chargement…</li>
                  )}
                  {users.map(u => (
                    <li key={u.id} className="file-item" style={{ gap: 8 }}>
                      <div className="file-type-icon">
                        {u.is_trusted
                          ? <UserCheckIcon size={16} strokeWidth={2} color={`var(--success)`} />
                          : <UserIcon size={16} strokeWidth={2} />
                        }
                      </div>
                      <div className="file-info">
                        <div className="file-name">{u.email}</div>
                        <div className="file-size">
                          {u.is_admin ? 'Admin · ' : ''}{u.is_trusted ? 'Trusted · ' : ''}
                          Membre depuis {new Date(u.created_at).toLocaleDateString('fr-FR')}
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap', color: 'var(--subtext)' }}
                        onClick={() => handleQuotaEdit(u)}
                        title="Modifier le quota"
                      >
                        {formatBytes(u.storage_quota_bytes)}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap', color: u.is_trusted ? 'var(--success)' : 'var(--subtext)' }}
                        onClick={() => handleTrustedToggle(u)}
                        title={u.is_trusted ? 'Retirer le statut trusted' : 'Marquer comme trusted'}
                      >
                        {u.is_trusted ? '✓ Trusted' : 'Trusted'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="card">
            <div className="card-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <p className="section-label" style={{ margin: 0 }}>Statistiques</p>
                <button className="btn btn-ghost btn-sm" onClick={() => loadStats(true)} disabled={statsLoading}>
                  Actualiser
                </button>
              </div>
              {statsLoading || !stats ? (
                <p className="text-subtext" style={{ padding: '8px 0', fontSize: '.875rem' }}>Chargement…</p>
              ) : (
                <StatsContent stats={stats} />
              )}
            </div>
          </div>

          {/* Logs */}
          <div className="card">
            <div className="card-body">
              <p className="section-label">Access Logs OVH</p>
              {logsUnavailable ? (
                <p className="text-subtext" style={{ padding: '12px 0', fontSize: '.875rem' }}>
                  Variable <code>S3_LOGS_BUCKET</code> non configurée.
                </p>
              ) : logs.length === 0 ? (
                <p className="text-subtext" style={{ padding: '12px 0', fontSize: '.875rem' }}>Chargement…</p>
              ) : (
                <ul className="file-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {logs.map(l => {
                    const name = l.key.split('/').pop() ?? l.key
                    const date = new Date(l.last_modified).toLocaleString('fr-FR')
                    const size = l.size < 1024 ? `${l.size} o` : `${(l.size / 1024).toFixed(1)} Ko`
                    return (
                      <li key={l.key} className="file-item" style={{ cursor: 'pointer' }} onClick={() => openLog(l.key)}>
                        <div className="file-type-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                          </svg>
                        </div>
                        <div className="file-info">
                          <div className="file-name">{name}</div>
                          <div className="file-size">{date} · {size}</div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Log viewer */}
          {logViewer && (
            <div className="card">
              <div className="card-body">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <p className="section-label" style={{ margin: 0 }}>{logViewer.key.split('/').pop()}</p>
                  <button className="btn btn-ghost btn-sm" onClick={() => setLogViewer(null)}>Fermer</button>
                </div>
                <pre style={{ fontSize: '.75rem', overflowX: 'auto', whiteSpace: 'pre-wrap', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, maxHeight: 400, overflowY: 'auto' }}>
                  {logViewer.content}
                </pre>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  )
}

function kpiCard(label: string, value: string, sub?: string) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--subtext)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }} dangerouslySetInnerHTML={{ __html: value }} />
      {sub && <div style={{ fontSize: 12, color: 'var(--subtext)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function StatsContent({ stats }: { stats: any }) {
  const s = stats
  const s3Ok = s.s3.total_bytes !== null

  const phantomLabel = s.phantom_bytes > 0
    ? `<span style="color:#F59E0B">${formatBytes(s.phantom_bytes)}</span>`
    : `<span style="color:var(--success)">Aucun</span>`

  const lastUpload = s.s3.last_upload ? new Date(s.s3.last_upload).toLocaleString('fr-FR') : '—'

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 20 }}>
        {kpiCard('Storage S3 réel', s3Ok ? formatBytes(s.s3.total_bytes) : '—', s3Ok ? `${s.s3.object_count} objet${s.s3.object_count > 1 ? 's' : ''}` : 'Erreur S3')}
        {kpiCard('Storage actif (DB)', formatBytes(s.db.active_bytes), 'fichiers non purgés')}
        {kpiCard('Transfers actifs', String(s.db.active_transfers), `sur ${s.db.total_transfers} au total`)}
        {kpiCard('Téléchargements', String(s.db.total_downloads), 'toutes périodes')}
        {kpiCard('Objets fantômes', s3Ok ? phantomLabel : '—', 'S3 − DB active')}
        {kpiCard('Dernier upload S3', s3Ok ? `<span style="font-size:13px">${lastUpload}</span>` : '—')}
      </div>
      <p className="section-label" style={{ marginBottom: 8 }}>Par utilisateur</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Utilisateur', 'Stockage actif / Quota', 'Actifs / Total', 'DL'].map((h, i) => (
                <th key={h} style={{ padding: 6, fontSize: 11, fontWeight: 600, textAlign: i === 0 ? 'left' : 'right', color: 'var(--subtext)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.users.map((u: any) => {
              const pct = u.storage_quota_bytes > 0 ? Math.min(100, Math.round(u.active_bytes / u.storage_quota_bytes * 100)) : 0
              const barColor = pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : 'var(--success)'
              return (
                <tr key={u.email}>
                  <td style={{ padding: '8px 6px', fontSize: '.875rem' }}>{u.email}</td>
                  <td style={{ padding: '8px 6px', fontSize: '.875rem', textAlign: 'right' }}>
                    <div>{formatBytes(u.active_bytes)}</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 3 }}>
                      <div style={{ width: 80, height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--subtext)' }}>{formatBytes(u.storage_quota_bytes)}</span>
                    </div>
                  </td>
                  <td style={{ padding: '8px 6px', fontSize: '.875rem', textAlign: 'right' }}>{u.active_transfers} / {u.total_transfers}</td>
                  <td style={{ padding: '8px 6px', fontSize: '.875rem', textAlign: 'right' }}>{u.downloads}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {s.s3.from_cache && (
        <p style={{ fontSize: '.75rem', color: 'var(--subtext)', marginTop: 12 }}>
          Données S3 depuis le cache (TTL 5 min). Cliquer sur Actualiser pour forcer.
        </p>
      )}
    </div>
  )
}
