import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

export default function LoginPage() {
  const [searchParams] = useSearchParams()
  const error = searchParams.get('error')
  const loggedOut = searchParams.get('logged_out') === '1'

  useEffect(() => {
    if (!error && !loggedOut) window.location.replace('/auth/oidc/login')
  }, [error, loggedOut])

  if (loggedOut) {
    return (
      <main className="login-wrap">
        <section className="login-card">
          <p className="section-label">Déconnexion</p>
          <h1 className="login-title">Vous êtes déconnecté</h1>
          <a className="btn btn-primary btn-full" href="/auth/oidc/login">Se connecter</a>
        </section>
      </main>
    )
  }

  if (error === 'access_denied') {
    return (
      <main className="login-wrap">
        <section className="login-card" aria-labelledby="access-denied-title">
          <p className="section-label">Accès non autorisé</p>
          <h1 id="access-denied-title" className="login-title">Votre compte n’a pas accès à OlfTransfer</h1>
          <p className="login-sub">Demandez à un administrateur Passerelle d’autoriser OlfTransfer pour votre compte, puis réessayez.</p>
          <a className="btn btn-primary btn-full" href="/auth/oidc/login?prompt=login">Essayer avec un autre compte</a>
        </section>
      </main>
    )
  }

  if (error === 'oidc') {
    return (
      <main className="login-wrap">
        <section className="login-card" aria-labelledby="connection-error-title">
          <p className="section-label">Connexion interrompue</p>
          <h1 id="connection-error-title" className="login-title">La connexion avec Passerelle n’a pas abouti</h1>
          <p className="login-sub">Réessayez. Si le problème persiste, vérifiez que Passerelle est disponible.</p>
          <a className="btn btn-primary btn-full" href="/auth/oidc/login">Réessayer</a>
        </section>
      </main>
    )
  }

  return (
    <main className="login-wrap" aria-live="polite"><p>Redirection vers Passerelle…</p></main>
  )
}
