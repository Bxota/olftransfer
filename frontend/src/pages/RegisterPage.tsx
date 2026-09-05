import { FormEvent, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../App'

type State = 'loading' | 'invalid' | 'form'

export default function RegisterPage() {
  const navigate = useNavigate()
  const { setUser } = useAuth()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''

  const [state, setState] = useState<State>('loading')
  const [inviteEmail, setInviteEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!token) { setState('invalid'); return }
    fetch(`/admin/invite/${token}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data) { setState('invalid'); return }
        setInviteEmail(data.email)
        setState('form')
      })
      .catch(() => setState('invalid'))
  }, [token])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== password2) {
      setError('Les mots de passe ne correspondent pas.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      if (res.ok) {
        const me = await fetch('/auth/me').then(r => r.json())
        setUser(me)
        navigate('/')
      } else {
        setError((await res.json()).detail)
      }
    } catch {
      setError('Erreur réseau.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-wrap auth-surface">
      <div className="login-card">
        <div className="login-logo">
          <div className="logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <span className="logo-name">OlfTransfer</span>
        </div>

        {state === 'loading' && (
          <div className="text-center text-subtext">Vérification de l'invitation…</div>
        )}

        {state === 'invalid' && (
          <div className="alert alert-error">Cette invitation est invalide ou a expiré.</div>
        )}

        {state === 'form' && (
          <>
            <h1 className="login-title">Créer mon compte</h1>
            <p className="login-sub">
              Invitation pour <strong>{inviteEmail}</strong>
            </p>
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="password">Choisir un mot de passe</label>
                <input
                  id="password"
                  type="password"
                  placeholder="8 caractères minimum"
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>
              <div className="field mt-3">
                <label htmlFor="password2">Confirmer le mot de passe</label>
                <input
                  id="password2"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  value={password2}
                  onChange={e => setPassword2(e.target.value)}
                />
              </div>
              {error && <div className="alert alert-error mt-3">{error}</div>}
              <button type="submit" className="btn btn-primary btn-full mt-4" disabled={loading}>
                {loading ? 'Création…' : 'Créer mon compte'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}
