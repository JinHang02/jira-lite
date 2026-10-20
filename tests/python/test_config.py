"""Tests for jira_lite.config: .env parsing, overrides and validation."""

import os
import shutil
import tempfile
import unittest

from jira_lite.config import (ConfigError, Settings, load_settings, merge_env,
                              parse_env, read_env_file, settings_from_env)

FULL = {"JIRA_SITE": "https://x.atlassian.net", "JIRA_EMAIL": "a@b.c", "JIRA_TOKEN": "t"}


class ParseEnvTest(unittest.TestCase):
    def test_basic_and_whitespace(self):
        env = parse_env("A=1\n  B = two words  \n")
        self.assertEqual(env, {"A": "1", "B": "two words"})

    def test_quotes_are_stripped(self):
        env = parse_env("A=\"double\"\nB='single'\nC=\"\"\nD='it''s'\n")
        self.assertEqual(env["A"], "double")
        self.assertEqual(env["B"], "single")
        self.assertEqual(env["C"], "")
        self.assertEqual(env["D"], "it''s")

    def test_comments_blank_and_invalid_lines_ignored(self):
        env = parse_env("# comment\n\n   # indented comment\nnot a pair\nA=1\n")
        self.assertEqual(env, {"A": "1"})

    def test_value_may_contain_equals_and_hash(self):
        env = parse_env("TOKEN=abc=def#ghi\n")
        self.assertEqual(env["TOKEN"], "abc=def#ghi")

    def test_later_lines_win(self):
        self.assertEqual(parse_env("A=1\nA=2\n"), {"A": "2"})


class ReadEnvFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_missing_file_is_empty(self):
        self.assertEqual(read_env_file(os.path.join(self.tmp, "nope")), {})

    def test_reads_file(self):
        path = os.path.join(self.tmp, ".env")
        with open(path, "w") as f:
            f.write("JIRA_SITE='https://s.atlassian.net/'\nJIRA_EMAIL=e\nJIRA_TOKEN=t\n")
        s = load_settings(env_file=path, environ={})
        self.assertEqual(s.site, "https://s.atlassian.net")  # trailing slash removed
        self.assertEqual((s.email, s.token), ("e", "t"))


class MergeAndValidateTest(unittest.TestCase):
    def test_env_overrides_file_only_for_jira_keys(self):
        merged = merge_env({"JIRA_PROJECT": "A", "OTHER": "x"},
                           {"JIRA_PROJECT": "B", "HOME": "/h", "OTHER": "y"})
        self.assertEqual(merged, {"JIRA_PROJECT": "B", "OTHER": "x"})

    def test_defaults(self):
        s = settings_from_env(FULL)
        self.assertEqual((s.project, s.port, s.host), ("BA", 8765, "127.0.0.1"))
        self.assertEqual(s.timeout, 20.0)

    def test_missing_keys_listed(self):
        with self.assertRaises(ConfigError) as cm:
            settings_from_env({"JIRA_SITE": "https://x"})
        self.assertEqual(cm.exception.missing, ["JIRA_EMAIL", "JIRA_TOKEN"])
        self.assertIn("Missing JIRA_EMAIL, JIRA_TOKEN", str(cm.exception))
        self.assertIn(".env.example", str(cm.exception))

    def test_empty_value_counts_as_missing(self):
        with self.assertRaises(ConfigError) as cm:
            settings_from_env(dict(FULL, JIRA_TOKEN=""))
        self.assertEqual(cm.exception.missing, ["JIRA_TOKEN"])

    def test_empty_env_var_overrides_file_value(self):
        with self.assertRaises(ConfigError):
            settings_from_env(merge_env(FULL, {"JIRA_TOKEN": ""}))

    def test_port(self):
        self.assertEqual(settings_from_env(FULL, port="9000").port, 9000)
        for bad in ("abc", "70000", "-1"):
            with self.assertRaises(ConfigError):
                settings_from_env(FULL, port=bad)

    def test_load_settings_env_override(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, ".env")
        with open(path, "w") as f:
            f.write("JIRA_SITE=https://file\nJIRA_EMAIL=file@x\nJIRA_TOKEN=ft\n")
        s = load_settings(env_file=path,
                          environ={"JIRA_EMAIL": "env@x", "JIRA_PROJECT": "ENV", "PORT": "9001"})
        self.assertEqual((s.site, s.email, s.token), ("https://file", "env@x", "ft"))
        self.assertEqual((s.project, s.port), ("ENV", 9001))

    def test_auth_header_and_repr_hides_token(self):
        s = Settings(site="https://x", email="a@b.c", token="tok")
        self.assertEqual(s.auth_header, "Basic YUBiLmM6dG9r")  # base64("a@b.c:tok")
        self.assertNotIn("tok", repr(s).replace("token", ""))


if __name__ == "__main__":
    unittest.main()


class ExposureSettingsTest(unittest.TestCase):
    def test_defaults_are_loopback_http(self):
        s = settings_from_env(FULL)
        self.assertEqual((s.host, s.scheme, s.tls_cert, s.public_hosts), ("127.0.0.1", "http", "", ()))

    def test_public_hosts_are_split_and_trimmed(self):
        s = settings_from_env(dict(FULL, JIRA_LITE_PUBLIC_HOSTS=" 192.168.0.113 , box.local ,"))
        self.assertEqual(s.public_hosts, ("192.168.0.113", "box.local"))

    def test_network_bind_is_refused_while_auth_is_a_shared_token(self):
        for host in ("0.0.0.0", "192.168.0.113", "::"):
            with self.subTest(host=host):
                with self.assertRaises(ConfigError) as ctx:
                    settings_from_env(dict(FULL, JIRA_LITE_BIND=host))
                self.assertIn("API token", str(ctx.exception))
        self.assertEqual(settings_from_env(dict(FULL, JIRA_LITE_BIND="localhost")).host, "localhost")

    def test_tls_needs_both_files_and_they_must_exist(self):
        with self.assertRaises(ConfigError):
            settings_from_env(dict(FULL, JIRA_LITE_TLS_CERT="certs/server.crt"))
        with self.assertRaises(ConfigError):
            settings_from_env(dict(FULL, JIRA_LITE_TLS_CERT="/nope.crt", JIRA_LITE_TLS_KEY="/nope.key"))
        tmp = tempfile.mkdtemp()
        try:
            cert, key = os.path.join(tmp, "c.pem"), os.path.join(tmp, "k.pem")
            for p in (cert, key):
                open(p, "w").close()
            s = settings_from_env(dict(FULL, JIRA_LITE_TLS_CERT=cert, JIRA_LITE_TLS_KEY=key))
            self.assertEqual((s.tls_cert, s.tls_key, s.scheme), (cert, key, "https"))
        finally:
            shutil.rmtree(tmp)


OAUTH = {"JIRA_SITE": "https://x.atlassian.net", "ATLASSIAN_CLIENT_ID": "cid",
         "ATLASSIAN_CLIENT_SECRET": "csecret", "JIRA_LITE_BASE_URL": "http://localhost:8765"}


class OAuthSettingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cert, self.key = os.path.join(self.tmp, "c.pem"), os.path.join(self.tmp, "k.pem")
        for p in (self.cert, self.key):
            open(p, "w").close()

    def tls(self, **extra):
        return dict(OAUTH, JIRA_LITE_TLS_CERT=self.cert, JIRA_LITE_TLS_KEY=self.key,
                    JIRA_LITE_BASE_URL="https://192.168.0.113:8765", **extra)

    def test_oauth_mode_needs_no_email_or_token(self):
        s = settings_from_env(OAUTH)
        self.assertTrue(s.oauth)
        self.assertEqual((s.oauth_client_id, s.oauth_client_secret), ("cid", "csecret"))
        self.assertEqual(s.redirect_uri, "http://localhost:8765/oauth/callback")
        self.assertEqual((s.email, s.token), ("", ""))
        self.assertEqual((s.atlassian_auth_url, s.atlassian_api_url),
                         ("https://auth.atlassian.com", "https://api.atlassian.com"))

    def test_token_mode_unchanged_without_client_id(self):
        s = settings_from_env(dict(FULL, ATLASSIAN_CLIENT_SECRET="x", JIRA_LITE_BASE_URL="http://localhost:1"))
        self.assertFalse(s.oauth)
        self.assertEqual((s.base_url, s.oauth_client_secret), ("", ""))

    def test_oauth_required_keys(self):
        with self.assertRaises(ConfigError) as cm:
            settings_from_env({"ATLASSIAN_CLIENT_ID": "cid"})
        self.assertEqual(cm.exception.missing, ["JIRA_SITE", "ATLASSIAN_CLIENT_SECRET", "JIRA_LITE_BASE_URL"])

    def test_base_url_validated_and_normalised(self):
        self.assertEqual(settings_from_env(dict(OAUTH, JIRA_LITE_BASE_URL="http://LocalHost:8765/")).base_url,
                         "http://localhost:8765")
        for bad in ("localhost:8765", "ftp://x", "http://x/app", "http://x?q=1", "http://u:p@x",
                    "https://x"):  # the last needs TLS
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError):
                    settings_from_env(dict(OAUTH, JIRA_LITE_BASE_URL=bad))
        s = settings_from_env(self.tls())
        self.assertEqual((s.base_url, s.base_host), ("https://192.168.0.113:8765", "192.168.0.113:8765"))
        with self.assertRaises(ConfigError):  # scheme must match the server's
            settings_from_env(dict(self.tls(), JIRA_LITE_BASE_URL="http://192.168.0.113:8765"))

    def test_bind_guard(self):
        for host in ("0.0.0.0", "192.168.0.113"):
            with self.subTest(host=host, mode="token+tls"):
                env = dict(FULL, JIRA_LITE_BIND=host, JIRA_LITE_TLS_CERT=self.cert, JIRA_LITE_TLS_KEY=self.key)
                with self.assertRaises(ConfigError) as ctx:
                    settings_from_env(env)
                self.assertIn("API token", str(ctx.exception))
            with self.subTest(host=host, mode="oauth without tls"):
                with self.assertRaises(ConfigError) as ctx:
                    settings_from_env(dict(OAUTH, JIRA_LITE_BIND=host))
                self.assertIn("HTTPS", str(ctx.exception))
            with self.subTest(host=host, mode="oauth+tls"):
                self.assertEqual(settings_from_env(self.tls(JIRA_LITE_BIND=host)).host, host)
        self.assertEqual(settings_from_env(dict(OAUTH, JIRA_LITE_BIND="127.0.0.1")).host, "127.0.0.1")

    def test_env_overrides_atlassian_keys(self):
        merged = merge_env({"ATLASSIAN_CLIENT_ID": "file"},
                           {"ATLASSIAN_CLIENT_ID": "env", "ATLASSIAN_CLIENT_SECRET": "s", "OTHER": "x"})
        self.assertEqual(merged, {"ATLASSIAN_CLIENT_ID": "env", "ATLASSIAN_CLIENT_SECRET": "s"})

    def test_repr_hides_client_secret(self):
        self.assertNotIn("csecret", repr(settings_from_env(OAUTH)))
