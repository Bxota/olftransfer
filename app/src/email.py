import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def send_invite(to_email: str, invite_url: str, invited_by: str):
    smtp_host = os.environ["SMTP_HOST"]
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_password = os.environ.get("SMTP_PASSWORD", "")
    smtp_from = os.environ.get("SMTP_FROM", smtp_user)

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

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.ehlo()
        server.starttls()
        if smtp_user:
            server.login(smtp_user, smtp_password)
        server.sendmail(smtp_from, to_email, msg.as_string())
