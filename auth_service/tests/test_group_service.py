from contextlib import contextmanager
from datetime import datetime, timezone
import unittest
from unittest.mock import patch

from app import group_service


class FakeCursor:
    def __init__(self, fetchone_rows=None, fetchall_rows=None):
        self.fetchone_rows = list(fetchone_rows or [])
        self.fetchall_rows = list(fetchall_rows or [])
        self.executed = []

    def execute(self, query, params):
        self.executed.append((query, params))

    def fetchone(self):
        if not self.fetchone_rows:
            return None
        return self.fetchone_rows.pop(0)

    def fetchall(self):
        return list(self.fetchall_rows)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


@contextmanager
def fake_connection(cursor):
    yield FakeConnection(cursor)


class GroupServiceSyncTests(unittest.TestCase):
    def setUp(self):
        self.current = group_service.CurrentUser(
            jid="t1.owner@v1.chat.rediff.com",
            tenant_slug="t1",
            vhost="v1.chat.rediff.com",
        )
        self.group = {
            "id": 42,
            "tenant_slug": "t1",
            "vhost": "v1.chat.rediff.com",
            "muc_jid": "team-42@conference.v1.chat.rediff.com",
            "room_node": "team-42",
            "name": "Team 42",
            "description": "",
            "created_by_jid": self.current.jid,
            "owner_jid": self.current.jid,
            "visibility": "tenant_private",
            "membership_mode": "members_only",
            "status": "active",
        }

    def test_missing_room_error_detection(self):
        self.assertTrue(group_service.ejabberd.is_missing_room_error(RuntimeError("room doesn't exist")))
        self.assertTrue(group_service.ejabberd.is_missing_room_error(RuntimeError("room not found")))
        self.assertFalse(group_service.ejabberd.is_missing_room_error(RuntimeError("permission denied")))

    def test_sync_room_members_pushes_affiliations(self):
        members = [
            {
                "member_jid": self.current.jid,
                "role": "owner",
                "affiliation": "owner",
                "created_at": datetime.now(timezone.utc),
            },
            {
                "member_jid": "t1.alice@v1.chat.rediff.com",
                "role": "member",
                "affiliation": "member",
                "created_at": datetime.now(timezone.utc),
            },
            {
                "member_jid": "t1.bob@v1.chat.rediff.com",
                "role": "admin",
                "affiliation": "admin",
                "created_at": datetime.now(timezone.utc),
            },
        ]
        cursor = FakeCursor(fetchall_rows=members)
        calls = []

        with patch.object(group_service, "_group_row", return_value=self.group), patch.object(
            group_service, "_member_row", return_value={"member_jid": self.current.jid, "role": "owner", "affiliation": "owner"}
        ), patch.object(group_service.database, "connection", side_effect=lambda: fake_connection(cursor)), patch.object(
            group_service.ejabberd, "set_room_affiliation", side_effect=lambda muc, jid, aff: calls.append((muc, jid, aff)) or True
        ), patch.object(group_service.ejabberd, "remove_room_affiliation") as remove_affiliation:
            result = group_service.sync_room_members(42, self.current)

        self.assertEqual(result["success"], True)
        self.assertEqual(result["synced_members"], 3)
        self.assertEqual(result["skipped_members"], 0)
        self.assertEqual(calls, [
            ("team-42@conference.v1.chat.rediff.com", self.current.jid, "owner"),
            ("team-42@conference.v1.chat.rediff.com", "t1.alice@v1.chat.rediff.com", "member"),
            ("team-42@conference.v1.chat.rediff.com", "t1.bob@v1.chat.rediff.com", "admin"),
        ])
        remove_affiliation.assert_not_called()

    def test_add_member_syncs_live_room(self):
        cursor = FakeCursor(
            fetchone_rows=[
                {
                    "member_jid": "t1.alice@v1.chat.rediff.com",
                    "role": "member",
                    "affiliation": "member",
                    "created_at": datetime.now(timezone.utc),
                }
            ]
        )
        with patch.object(group_service, "_group_row", return_value=self.group), patch.object(
            group_service, "_ensure_editor", return_value={"member_jid": self.current.jid, "role": "owner", "affiliation": "owner"}
        ), patch.object(group_service.keycloak, "sync_user_active", return_value=True), patch.object(
            group_service.database, "connection", side_effect=lambda: fake_connection(cursor)
        ), patch.object(
            group_service.ejabberd, "set_room_affiliation", return_value=True
        ) as set_affiliation:
            response = group_service.add_member(
                42,
                group_service.schemas.GroupMemberCreate(member_jid="t1.alice@v1.chat.rediff.com", role="member"),
                self.current,
            )

        self.assertEqual(response.member_jid, "t1.alice@v1.chat.rediff.com")
        set_affiliation.assert_called_once_with("team-42@conference.v1.chat.rediff.com", "t1.alice@v1.chat.rediff.com", "member")

    def test_remove_member_syncs_live_room(self):
        cursor = FakeCursor()
        with patch.object(group_service, "_group_row", return_value=self.group), patch.object(
            group_service, "_member_row", side_effect=[
                {"member_jid": self.current.jid, "role": "owner", "affiliation": "owner"},
                {"member_jid": "t1.alice@v1.chat.rediff.com", "role": "member", "affiliation": "member"},
            ],
        ), patch.object(group_service.keycloak, "sync_user_active", return_value=True), patch.object(
            group_service.database, "connection", side_effect=lambda: fake_connection(cursor)
        ), patch.object(
            group_service.ejabberd, "remove_room_affiliation", return_value=True
        ) as remove_affiliation:
            result = group_service.remove_member(42, "t1.alice@v1.chat.rediff.com", self.current)

        self.assertEqual(result, {"success": True})
        remove_affiliation.assert_called_once_with("team-42@conference.v1.chat.rediff.com", "t1.alice@v1.chat.rediff.com")

    def test_get_group_keeps_stored_members_and_repairs_live_affiliations(self):
        members = [
            {
                "member_jid": self.current.jid,
                "role": "owner",
                "affiliation": "owner",
                "created_at": datetime.now(timezone.utc),
            },
            {
                "member_jid": "t1.alice@v1.chat.rediff.com",
                "role": "member",
                "affiliation": "member",
                "created_at": datetime.now(timezone.utc),
            },
        ]
        cursor = FakeCursor(fetchall_rows=members)
        calls = []

        with patch.object(group_service, "_group_row", return_value=self.group), patch.object(
            group_service, "_member_row", return_value={"member_jid": self.current.jid, "role": "owner", "affiliation": "owner"}
        ), patch.object(group_service.database, "connection", side_effect=lambda: fake_connection(cursor)), patch.object(
            group_service.ejabberd, "set_room_affiliation", side_effect=lambda muc, jid, aff: calls.append((muc, jid, aff)) or True
        ):
            response = group_service.get_group(42, self.current)

        self.assertEqual([member.member_jid for member in response.members], [self.current.jid, "t1.alice@v1.chat.rediff.com"])
        self.assertFalse(any("DELETE FROM rediff_group_members" in query for query, _ in cursor.executed))
        self.assertEqual(calls, [
            ("team-42@conference.v1.chat.rediff.com", self.current.jid, "owner"),
            ("team-42@conference.v1.chat.rediff.com", "t1.alice@v1.chat.rediff.com", "member"),
        ])


if __name__ == "__main__":
    unittest.main()
