"""HTTPS serving: the app wraps its socket when a certificate is configured."""

import http.client
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest

from app.app import create_server
from app.config import Settings

from .support import make_web_root

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@unittest.skipUnless(shutil.which("openssl"), "openssl not installed")
class TlsServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Run the real cert script against a scratch copy so the repo's certs/ is untouched.
        cls.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(cls.tmp, "scripts"))
        shutil.copy(os.path.join(ROOT, "scripts", "make-cert.sh"), os.path.join(cls.tmp, "scripts"))
        subprocess.run(["sh", os.path.join(cls.tmp, "scripts", "make-cert.sh"), "10.1.2.3", "box.local"],
                       check=True, capture_output=True, timeout=60)
        cls.certs = os.path.join(cls.tmp, "certs")
        cls.web_tmp, cls.web = make_web_root()
        settings = Settings(site="http://127.0.0.1:9", email="e", token="t", project="TST", port=0,
                            tls_cert=os.path.join(cls.certs, "server.crt"),
                            tls_key=os.path.join(cls.certs, "server.key"),
                            public_hosts=("10.1.2.3", "box.local"))
        cls.app = create_server(settings, web_root=cls.web, quiet=True)
        cls.thread = threading.Thread(target=cls.app.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.app.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.web_tmp, ignore_errors=True)

    def get(self, path, host="localhost", ctx=None):
        ctx = ctx or ssl.create_default_context(cafile=os.path.join(self.certs, "ca.crt"))
        conn = http.client.HTTPSConnection("127.0.0.1", self.app.port, context=ctx, timeout=5)
        try:
            conn.putrequest("GET", path, skip_host=True)
            conn.putheader("Host", "%s:%d" % (host, self.app.port))
            conn.endheaders()
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()

    def test_serves_https_with_ca_signed_cert(self):
        ctx = ssl.create_default_context(cafile=os.path.join(self.certs, "ca.crt"))
        ctx.check_hostname = False  # we connect by 127.0.0.1; SANs are checked below
        status, _ = self.get("/", ctx=ctx)
        self.assertEqual(status, 200)

    def test_certificate_lists_requested_hosts(self):
        out = subprocess.run(["openssl", "x509", "-in", os.path.join(self.certs, "server.crt"), "-noout", "-ext",
                              "subjectAltName"], check=True, capture_output=True, text=True, timeout=30).stdout
        for name in ("DNS:localhost", "IP Address:127.0.0.1", "IP Address:10.1.2.3", "DNS:box.local"):
            self.assertIn(name, out)

    def test_public_hosts_pass_host_check(self):
        ctx = ssl.create_default_context(cafile=os.path.join(self.certs, "ca.crt"))
        ctx.check_hostname = False
        self.assertEqual(self.get("/config", host="10.1.2.3", ctx=ctx)[0], 200)
        self.assertEqual(self.get("/config", host="box.local", ctx=ctx)[0], 200)
        self.assertEqual(self.get("/config", host="evil.example", ctx=ctx)[0], 403)

    def test_untrusted_client_is_rejected_without_crashing(self):
        # A client that trusts no CA at all (not the system store, which can be slow to load).
        untrusted = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with self.assertRaises(ssl.SSLError):
            self.get("/", ctx=untrusted)
        ctx = ssl.create_default_context(cafile=os.path.join(self.certs, "ca.crt"))
        ctx.check_hostname = False
        self.assertEqual(self.get("/", ctx=ctx)[0], 200)  # still serving


if __name__ == "__main__":
    unittest.main()
