import UploadIcon from '../icons/upload-icon'

export default function LoginPage() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <Logo />
          <span className="logo-name">OlfTransfer</span>
        </div>
        <h1 className="login-title">Connexion</h1>
        <p className="login-sub">Utilise ton compte Passerelle pour envoyer et gérer tes fichiers.</p>
        <a className="btn btn-outline btn-full mt-4 provider-button" href="/auth/oidc/login">
          <PasserelleMark />
          Se connecter avec Passerelle
        </a>
        <a className="btn btn-ghost btn-full mt-3" href="/auth/oidc/login?prompt=login">
          Se connecter avec un autre compte
        </a>
      </div>
    </div>
  )
}

function PasserelleMark() {
  return (
    <svg className="provider-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M4 17h16M7 4v16M17 4v16" />
      <path d="M4 12h16" />
    </svg>
  )
}

function Logo() {
  return (
    <div className="logo-icon">
      <UploadIcon size={18} strokeWidth={2.5} />
    </div>
  )
}
