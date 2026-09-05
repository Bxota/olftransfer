import { Link } from 'react-router-dom'
import { useAuth } from '../App'
import UploadIcon from '../icons/upload-icon'

export default function NotFoundPage() {
  const { user, loading } = useAuth()

  return (
    <>
      <header className="header public-header">
        <Link to="/" className="logo">
          <div className="logo-icon">
            <UploadIcon size={18} strokeWidth={2.4} />
          </div>
          <span className="logo-name">OlfTransfer</span>
        </Link>
      </header>

      <main className="page public-surface not-found-page">
        <section className="card not-found-card" aria-labelledby="not-found-title">
          <div className="card-body text-center">
            <span className="not-found-code" aria-hidden="true">404</span>
            <h1 id="not-found-title">Cette page est introuvable</h1>
            <p>L’adresse est peut-être incorrecte ou la page n’est plus disponible.</p>
            {!loading && (user ? (
              <Link className="btn btn-primary" to="/">Revenir à l’accueil</Link>
            ) : (
              <a className="btn btn-primary" href="/auth/oidc/login">Se connecter pour revenir à l’accueil</a>
            ))}
          </div>
        </section>
      </main>
    </>
  )
}
