import os
import unittest
import urllib.parse
from unittest.mock import patch

from fastapi import HTTPException

from src.auth import create_session, get_session_id_token, get_session_user_id
from src.oidc import OIDCConfig, _backchannel_endpoint, begin_authorization, complete_authorization, end_session_url, is_user_authorized


class OIDCFlowTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(
            os.environ,
            {
                "APP_SECRET": "test-secret-with-enough-entropy",
                "OIDC_ISSUER": "https://auth.example.test/",
                "OIDC_CLIENT_ID": "olftransfer",
                "OIDC_REDIRECT_URI": "https://olf.example.test/auth/oidc/callback",
                "OIDC_BACKCHANNEL_URL": "http://identity:8080",
            },
            clear=False,
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()

    def test_authorization_request_uses_pkce_s256(self):
        authorization_url, transaction = begin_authorization("login")
        parsed = urllib.parse.urlparse(authorization_url)
        query = urllib.parse.parse_qs(parsed.query)

        self.assertEqual(parsed.scheme + "://" + parsed.netloc, "https://auth.example.test")
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["client_id"], ["olftransfer"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["prompt"], ["login"])
        self.assertEqual(len(query["code_challenge"][0]), 43)
        self.assertTrue(transaction)

    def test_callback_rejects_state_before_network_exchange(self):
        _, transaction = begin_authorization()
        with self.assertRaises(HTTPException) as raised:
            complete_authorization("code", "attacker-state", transaction)
        self.assertEqual(raised.exception.status_code, 400)

    def test_backchannel_keeps_only_endpoints_from_the_issuer(self):
        cfg = OIDCConfig(
            issuer="https://auth.example.test",
            client_id="olftransfer",
            redirect_uri="https://olf.example.test/auth/oidc/callback",
            backchannel_url="http://identity:8080",
        )
        endpoint = _backchannel_endpoint(cfg, "https://auth.example.test/token")
        self.assertEqual(endpoint, "http://identity:8080/token")
        with self.assertRaises(HTTPException):
            _backchannel_endpoint(cfg, "https://attacker.example/token")

    @patch("src.oidc._get_json", return_value={"authorized": True})
    def test_authorization_check_uses_configured_client(self, get_json):
        self.assertTrue(is_user_authorized("user/id"))
        get_json.assert_called_once_with(
            "http://identity:8080/internal/applications/olftransfer/authorizations/user%2Fid"
        )

    @patch("src.oidc._get_json", return_value={"end_session_endpoint": "https://auth.example.test/logout"})
    def test_logout_uses_registered_rp_initiated_logout_parameters(self, _get_json):
        parsed = urllib.parse.urlparse(end_session_url("signed.id.token"))
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(parsed.scheme + "://" + parsed.netloc + parsed.path, "https://auth.example.test/logout")
        self.assertEqual(query["id_token_hint"], ["signed.id.token"])
        self.assertEqual(query["client_id"], ["olftransfer"])
        self.assertEqual(query["post_logout_redirect_uri"], ["https://olf.example.test/auth/logout?logged_out=1"])

    def test_local_session_retains_id_token_for_federated_logout(self):
        session = create_session("user-1", "signed.id.token")
        self.assertEqual(get_session_user_id(session), "user-1")
        self.assertEqual(get_session_id_token(session), "signed.id.token")


if __name__ == "__main__":
    unittest.main()
