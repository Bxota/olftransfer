import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { formatBytes } from '../lib/utils'
import UserIcon from '../icons/user-icon'
import { AppNavigation } from '../components/AppNavigation'

interface UserItem {
  id: string
  pseudonym: string | null
  email: string
  is_admin: boolean
  created_at: string
  storage_quota_bytes: number
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
  useEffect(() => {
    loadUsers()
    loadStats()
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

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' })
    setUser(null)
    navigate('/login')
  }

  return (
    <>
      <AppNavigation />

      <main className="page app-main app-surface admin-surface">
        <div className="page-admin">
          <div className="admin-grid">
            {/* Invite */}
            <div className="card">
              <div className="card-body">
                <p className="section-label">Gestion des accès</p>
                <h2 style={{ fontSize: 18, marginBottom: 8 }}>Invitations et autorisations</h2>
                <p className="text-subtext" style={{ fontSize: 13, marginBottom: 18 }}>Les comptes et leurs accès sont gérés dans Passerelle.</p>
                <a className="btn btn-primary btn-full" href="/auth/passerelle/admin">Ouvrir l’administration Passerelle</a>
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
                        <UserIcon size={16} strokeWidth={2} />
                      </div>
                      <div className="file-info">
                        <div className="file-name">{u.pseudonym || 'Pseudo non défini'}</div>
                        <div className="user-email">{u.email}</div>
                        <div className="file-size">
                          {u.is_admin ? 'Admin · ' : ''}
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
                  <td style={{ padding: '8px 6px', fontSize: '.875rem' }}>
                    <div>{u.pseudonym || 'Pseudo non défini'}</div>
                    <div className="user-email">{u.email}</div>
                  </td>
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
