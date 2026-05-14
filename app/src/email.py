import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def _send(msg: MIMEMultipart) -> None:
    smtp_host = os.environ["SMTP_HOST"]
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_password = os.environ.get("SMTP_PASSWORD", "")

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.ehlo()
        server.starttls()
        if smtp_user:
            server.login(smtp_user, smtp_password)
        server.sendmail(msg["From"], msg["To"], msg.as_string())


def send_download_notification(to_email: str, token: str, file_count: int, total_bytes: int):
    smtp_from = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", ""))

    size_mb = total_bytes / (1024 * 1024)
    size_str = f"{size_mb:.1f} Mo" if size_mb >= 1 else f"{total_bytes // 1024} Ko"
    file_word = "fichier" if file_count == 1 else "fichiers"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Votre transfert a été téléchargé — {token}"
    msg["From"] = smtp_from
    msg["To"] = to_email

    text = (
        f"Votre transfert ({token}) vient d'être téléchargé.\n\n"
        f"{file_count} {file_word} · {size_str}\n"
    )
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2 style="font-size:20px">Transfert téléchargé</h2>
      <p>Votre transfert <code>{token}</code> vient d'être téléchargé.</p>
      <p style="color:#6B7280;font-size:14px">{file_count} {file_word} &middot; {size_str}</p>
    </div>
    """

    msg.attach(MIMEText(text, "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        _send(msg)
    except Exception:
        logger.exception("Failed to send download notification to %s (token=%s)", to_email, token)


def send_invite(to_email: str, invite_url: str, invited_by: str):
    smtp_from = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", ""))

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Invitation OlfTransfer"
    msg["From"] = smtp_from
    msg["To"] = to_email

    text = (
        f"{invited_by} t'invite sur OlfTransfer.\n\n"
        f"Crée ton compte ici :\n{invite_url}\n\n"
        "Ce lien expire dans 48h."
    )
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2 style="font-size:20px">Invitation OlfTransfer</h2>
      <p><strong>{invited_by}</strong> t'invite à rejoindre OlfTransfer.</p>
      <a href="{invite_url}" style="display:inline-block;margin:20px 0;padding:12px 24px;
         background:#2563EB;color:white;border-radius:8px;text-decoration:none;font-weight:600">
        Créer mon compte
      </a>
      <p style="color:#6B7280;font-size:13px">Ce lien expire dans 48h.</p>
    </div>
    """

    msg.attach(MIMEText(text, "plain"))
    msg.attach(MIMEText(html, "html"))

    _send(msg)
