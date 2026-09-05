import os
import zipfile
from email.mime.multipart import MIMEMultipart
from io import BytesIO
from unittest import TestCase
from unittest.mock import Mock, patch

from src.email import _send, send_download_notification
from src.main import _build_transfer_zip, _cleanup_file


class DownloadNotificationTests(TestCase):
    @patch.dict(os.environ, {"S3_BUCKET_NAME": "test-bucket"}, clear=False)
    @patch("src.main.get_client")
    def test_zip_builder_accepts_file_rows_with_the_file_id(self, get_client):
        client = Mock()
        client.get_object.return_value = {"Body": BytesIO(b"photo data")}
        get_client.return_value = client

        zip_path = _build_transfer_zip([("photo.jpg", 10, "transfers/photo.jpg", "file-id")])
        try:
            with zipfile.ZipFile(zip_path) as archive:
                self.assertEqual(archive.read("photo.jpg"), b"photo data")
        finally:
            _cleanup_file(zip_path)

    @patch("src.email._send", side_effect=OSError("SMTP unavailable"))
    def test_download_notification_propagates_smtp_errors_to_the_outbox_worker(self, _send):
        with self.assertRaisesRegex(OSError, "SMTP unavailable"):
            send_download_notification(
                "sender@example.test", "token", None, ["photo.jpg"], 10
            )

    @patch.dict(
        os.environ,
        {"SMTP_HOST": "smtp.example.test", "SMTP_PORT": "587", "SMTP_TIMEOUT_SECONDS": "12"},
        clear=False,
    )
    @patch("src.email.smtplib.SMTP")
    def test_smtp_connection_has_a_bounded_timeout(self, smtp):
        _send(MIMEMultipart())
        smtp.assert_called_once_with("smtp.example.test", 587, timeout=12.0)
