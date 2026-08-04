import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../App'
import UploadIcon from '../icons/upload-icon'
import UserIcon from '../icons/user-icon'

export function AppNavigation() {
  const location = useLocation()
  const { user } = useAuth()

  async function logout() {
    // A redirect is intentional: it also removes the Passerelle host-only
    // cookie, which a fetch to OLF cannot do.
    localStorage.setItem('olf-auth-event', JSON.stringify({ type: 'logout', at: Date.now() }))
    window.location.assign('/auth/logout')
  }

  const isAdmin = location.pathname === '/admin'
  return (
    <nav className="app-nav app-nav-compact" aria-label="Navigation principale">
      <Link to="/" className="nav-brand" aria-label="OlfTransfer, transferts">
        <span className="nav-brand-icon"><UploadIcon size={18} strokeWidth={2.5} /></span>
        <span className="nav-brand-name">OlfTransfer</span>
      </Link>

      <div className="nav-links">
        <Link to="/" className={!isAdmin ? 'nav-link active' : 'nav-link'}>Transferts</Link>
        {user?.is_admin && <Link to="/admin" className={isAdmin ? 'nav-link active' : 'nav-link'}>Administration</Link>}
      </div>

      <div className="nav-footer">
        <details className="nav-account">
          <summary className="nav-account-trigger" aria-label="Ouvrir le menu utilisateur">
            <span className="nav-account-icon"><UserIcon size={19} strokeWidth={1.9} /></span>
            <span className="nav-account-name">{user?.pseudonym || user?.email}</span>
          </summary>
          <div className="nav-account-menu">
            <div className="nav-account-heading">Votre compte</div>
            <a href="/auth/passerelle/account" target="_blank" rel="noopener noreferrer">Mon compte</a>
            <button onClick={() => window.location.assign('/auth/oidc/login?prompt=login')}>Changer de compte</button>
            <button onClick={logout}>Déconnexion</button>
          </div>
        </details>
      </div>
    </nav>
  )
}
