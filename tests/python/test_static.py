"""Unit tests for app.static path resolution and content types."""

import os
import shutil
import unittest

from app import static

from .support import make_web_root


class ResolveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp, cls.web = make_web_root()
        os.symlink(os.path.join(cls.tmp, "server.py"), os.path.join(cls.web, "escape.py"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_index_and_nested(self):
        self.assertEqual(static.resolve(self.web, "/"), os.path.join(self.web, "index.html"))
        self.assertEqual(static.resolve(self.web, "/css/style.css"), os.path.join(self.web, "css", "style.css"))
        self.assertEqual(static.resolve(self.web, "/with%20space.html"), os.path.join(self.web, "with space.html"))

    def test_not_found(self):
        for path in ("/nope.html", "/css", "/css/", ""):
            with self.subTest(path=path):
                self.assertIsNone(static.resolve(self.web, path))

    def test_traversal_blocked(self):
        for path in ("/../server.py", "/%2e%2e/server.py", "/%2E%2E/server.py", "/css/../../server.py",
                     "/..%2fserver.py", "//../server.py", "/%2fetc/passwd", "/../webby.txt",
                     "/escape.py", "/index.html%00.png"):
            with self.subTest(path=path):
                self.assertIsNone(static.resolve(self.web, path))

    def test_content_types(self):
        expected = {
            "a.html": "text/html; charset=utf-8",
            "a.js": "text/javascript; charset=utf-8",
            "a.css": "text/css; charset=utf-8",
            "a.svg": "image/svg+xml",
            "a.json": "application/json",
            "a.ico": "image/x-icon",
            "a.png": "image/png",
            "a.txt": "application/octet-stream",
            "noext": "application/octet-stream",
        }
        for name, ctype in expected.items():
            with self.subTest(name=name):
                self.assertEqual(static.content_type(name), ctype)


if __name__ == "__main__":
    unittest.main()
