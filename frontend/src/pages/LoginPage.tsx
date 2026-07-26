import UploadIcon from '../icons/upload-icon'
import passerelleMark from '../assets/passerelle-mark.svg'

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
  return <img className="provider-mark" src={passerelleMark} alt="" />
}

function Logo() {
  return (
    <div className="logo-icon">
      <UploadIcon size={18} strokeWidth={2.5} />
    </div>
  )
}
