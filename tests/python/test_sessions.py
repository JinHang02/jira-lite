"""Unit tests for app.sessions and app.cookies."""

import unittest

from app.cookies import expire_cookie, parse_cookies, set_cookie
from app.sessions import Session, SessionStore


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make_session(name: str = "a") -> Session:
    return Session("acc-" + name, "ref-" + name, 0.0, "cloud", "id-" + name, name)


class SessionStoreTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.store = SessionStore(idle_timeout=100, max_sessions=3, clock=self.clock)

    def test_create_get_delete(self):
        session = make_session()
        sid = self.store.create(session)
        self.assertGreaterEqual(len(sid), 40)
        self.assertIs(self.store.get(sid), session)
        self.assertIsNone(self.store.get("other"))
        self.assertIsNone(self.store.get(None))
        self.assertIsNone(self.store.get(""))
        self.store.delete(sid)
        self.assertIsNone(self.store.get(sid))
        self.store.delete(sid)  # idempotent
        self.store.delete(None)

    def test_ids_are_unique_and_not_stored_raw(self):
        ids = {self.store.create(make_session(str(i))) for i in range(3)}
        self.assertEqual(len(ids), 3)
        for sid in ids:
            self.assertNotIn(sid, self.store._sessions)

    def test_idle_expiry_is_sliding(self):
        sid = self.store.create(make_session())
        self.clock.now += 90
        self.assertIsNotNone(self.store.get(sid))  # use renews it
        self.clock.now += 90
        self.assertIsNotNone(self.store.get(sid))
        self.clock.now += 101
        self.assertIsNone(self.store.get(sid))
        self.assertEqual(len(self.store), 0)

    def test_cap_evicts_least_recently_used(self):
        a, b, c = (self.store.create(make_session(n)) for n in "abc")
        self.store.get(a)  # a is now the most recently used
        d = self.store.create(make_session("d"))
        self.assertEqual(len(self.store), 3)
        self.assertIsNone(self.store.get(b))
        for sid in (a, c, d):
            self.assertIsNotNone(self.store.get(sid))

    def test_purge_drops_expired(self):
        old = self.store.create(make_session("old"))
        self.clock.now += 60
        new = self.store.create(make_session("new"))
        self.clock.now += 50  # old idle 110 s, new idle 50 s
        self.store.purge()
        self.assertEqual(len(self.store), 1)
        self.assertIsNone(self.store.get(old))
        self.assertIsNotNone(self.store.get(new))

    def test_repr_hides_tokens(self):
        text = repr(make_session("x"))
        self.assertNotIn("acc-x", text)
        self.assertNotIn("ref-x", text)


class CookieTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_cookies('a=1; b="two"; junk; =x; a=3; c='), {"a": "1", "b": "two", "c": ""})
        self.assertEqual(parse_cookies(None), {})

    def test_set_and_expire(self):
        self.assertEqual(set_cookie("s", "v", secure=True),
                         "s=v; Path=/; HttpOnly; SameSite=Lax; Secure")
        self.assertEqual(set_cookie("s", "v", secure=False, path="/oauth", max_age=600),
                         "s=v; Path=/oauth; Max-Age=600; HttpOnly; SameSite=Lax")
        self.assertEqual(expire_cookie("s", secure=False), "s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")


if __name__ == "__main__":
    unittest.main()
