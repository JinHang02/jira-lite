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
