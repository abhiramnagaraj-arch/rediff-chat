from contextlib import contextmanager
from datetime import datetime, timezone
import unittest
from unittest.mock import call, patch

from app import message_service


class FakeCursor:
    def __init__(self, fetchall_rows=None):
        self.fetchall_rows = list(fetchall_rows or [])
        self.executed = []

    def execute(self, query, params):
        self.executed.append((query, params))

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


class MessageServiceSearchTests(unittest.TestCase):
    def test_short_queries_do_not_hit_database(self):
        cursor = FakeCursor()
        with patch.object(
            message_service.database,
            "connection",
            return_value=fake_connection(cursor),
        ):
            self.assertEqual(
                message_service.search_messages(
                    current_jid="t1.owner@v1.chat.rediff.com",
                    tenant_slug="t1",
                    vhost="v1.chat.rediff.com",
                    q="a",
                ),
                [],
            )

        self.assertEqual(cursor.executed, [])

    def test_search_messages_scopes_to_tenant_and_conversation(self):
        group_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "muc_jid": "team@conference.v1.chat.rediff.com",
                    "name": "Core Team",
                }
            ]
        )
        archive_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "archive_id": 77,
                    "username": "team@conference.v1.chat.rediff.com",
                    "timestamp": 1710000000000,
                    "peer": "t1.alice@v1.chat.rediff.com",
                    "bare_peer": "t1.alice@v1.chat.rediff.com",
                    "txt": "Project kickoff is tomorrow at 10am",
                    "xml": "<message><body>Project kickoff is tomorrow at 10am</body></message>",
                    "kind": "groupchat",
                    "origin_id": "msg-77",
                }
            ]
        )
        with patch.object(
            message_service.database,
            "connection",
            side_effect=lambda *args, **kwargs: fake_connection(
                group_cursor if not kwargs.get("database_name") else archive_cursor
            ),
        ) as mock_connection:
            results = message_service.search_messages(
                current_jid="t1.owner@v1.chat.rediff.com",
                tenant_slug="t1",
                vhost="v1.chat.rediff.com",
                q="kickoff tomorrow",
                with_jid="team@conference.v1.chat.rediff.com",
                start=datetime(2024, 1, 1, tzinfo=timezone.utc),
                end=datetime(2024, 12, 31, tzinfo=timezone.utc),
                limit=10,
            )

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.jid, "team@conference.v1.chat.rediff.com")
        self.assertEqual(result.name, "Core Team")
        self.assertEqual(result.type, "groupchat")
        self.assertEqual(result.snippet, "Project kickoff is tomorrow at 10am")
        self.assertEqual(result.origin_id, "msg-77")
        self.assertEqual(mock_connection.call_args_list, [call(), call(database_name="rediff_v1_db")])

        group_query, group_params = group_cursor.executed[0]
        self.assertIn("FROM rediff_groups g", group_query)
        self.assertEqual(group_params, ("t1", "v1.chat.rediff.com", "t1.owner@v1.chat.rediff.com"))

        query, params = archive_cursor.executed[0]
        self.assertIn("FROM archive a", query)
        self.assertEqual(params[0], "t1.owner@v1.chat.rediff.com")
        self.assertEqual(params[1], "t1.owner")
        self.assertEqual(params[2], "team@conference.v1.chat.rediff.com")
        self.assertIn("team@conference.v1.chat.rediff.com", params)

    def test_search_messages_accepts_localpart_username_alias(self):
        group_cursor = FakeCursor(fetchall_rows=[])
        archive_cursor = FakeCursor(fetchall_rows=[])
        with patch.object(
            message_service.database,
            "connection",
            side_effect=lambda *args, **kwargs: fake_connection(
                group_cursor if not kwargs.get("database_name") else archive_cursor
            ),
        ) as mock_connection:
            message_service.search_messages(
                current_jid="t1.owner@v1.chat.rediff.com",
                tenant_slug="t1",
                vhost="v1.chat.rediff.com",
                q="hello world",
            )

        group_query, group_params = group_cursor.executed[0]
        self.assertIn("FROM rediff_groups g", group_query)
        self.assertIn("t1.owner@v1.chat.rediff.com", group_params)

        query, params = archive_cursor.executed[0]
        self.assertIn("lower(a.username) IN", query)
        self.assertIn("t1.owner@v1.chat.rediff.com", params)
        self.assertIn("t1.owner", params)
        self.assertEqual(mock_connection.call_args_list, [call(), call(database_name="rediff_v1_db")])

    def test_search_messages_accepts_microsecond_archive_timestamp(self):
        group_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "muc_jid": "team@conference.v1.chat.rediff.com",
                    "name": "Core Team",
                }
            ]
        )
        archive_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "archive_id": 88,
                    "timestamp": 1710000000000000,
                    "peer": "team@conference.v1.chat.rediff.com",
                    "bare_peer": "team@conference.v1.chat.rediff.com",
                    "txt": "hello from microseconds",
                    "xml": "<message><body>hello from microseconds</body></message>",
                    "kind": "groupchat",
                    "origin_id": "msg-88",
                }
            ]
        )
        with patch.object(
            message_service.database,
            "connection",
            side_effect=lambda *args, **kwargs: fake_connection(
                group_cursor if not kwargs.get("database_name") else archive_cursor
            ),
        ):
            results = message_service.search_messages(
                current_jid="t1.owner@v1.chat.rediff.com",
                tenant_slug="t1",
                vhost="v1.chat.rediff.com",
                q="hello",
                with_jid="team@conference.v1.chat.rediff.com",
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].snippet, "hello from microseconds")
        self.assertEqual(results[0].timestamp.year, 2024)

    def test_search_messages_ignores_bad_archive_timestamp(self):
        group_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "muc_jid": "team@conference.v1.chat.rediff.com",
                    "name": "Core Team",
                }
            ]
        )
        archive_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "archive_id": "bad-id",
                    "username": "team@conference.v1.chat.rediff.com",
                    "timestamp": "not-a-number",
                    "peer": "team@conference.v1.chat.rediff.com",
                    "bare_peer": "team@conference.v1.chat.rediff.com",
                    "txt": "people people",
                    "xml": "<message><body>people people</body></message>",
                    "kind": "groupchat",
                    "origin_id": "msg-bad",
                }
            ]
        )
        with patch.object(
            message_service.database,
            "connection",
            side_effect=lambda *args, **kwargs: fake_connection(
                group_cursor if not kwargs.get("database_name") else archive_cursor
            ),
        ):
            results = message_service.search_messages(
                current_jid="t1.owner@v1.chat.rediff.com",
                tenant_slug="t1",
                vhost="v1.chat.rediff.com",
                q="people",
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].archive_id, 0)
        self.assertEqual(results[0].timestamp.year, 1970)

    def test_search_messages_ignores_overflow_archive_timestamp(self):
        group_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "muc_jid": "team@conference.v1.chat.rediff.com",
                    "name": "Core Team",
                }
            ]
        )
        archive_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "archive_id": 101,
                    "username": "team@conference.v1.chat.rediff.com",
                    "timestamp": 999999999999999999999,
                    "peer": "team@conference.v1.chat.rediff.com",
                    "bare_peer": "team@conference.v1.chat.rediff.com",
                    "txt": "people people",
                    "xml": "<message><body>people people</body></message>",
                    "kind": "groupchat",
                    "origin_id": "msg-overflow",
                }
            ]
        )
        with patch.object(
            message_service.database,
            "connection",
            side_effect=lambda *args, **kwargs: fake_connection(
                group_cursor if not kwargs.get("database_name") else archive_cursor
            ),
        ):
            results = message_service.search_messages(
                current_jid="t1.owner@v1.chat.rediff.com",
                tenant_slug="t1",
                vhost="v1.chat.rediff.com",
                q="people",
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].timestamp.year, 1970)

    def test_search_messages_skips_malformed_rows(self):
        group_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "muc_jid": "team@conference.v1.chat.rediff.com",
                    "name": "Core Team",
                }
            ]
        )
        archive_cursor = FakeCursor(
            fetchall_rows=[
                {
                    "archive_id": 102,
                    "username": "team@conference.v1.chat.rediff.com",
                    "timestamp": 1710000000000,
                    "peer": "team@conference.v1.chat.rediff.com",
                    "bare_peer": "team@conference.v1.chat.rediff.com",
                    "txt": "people people",
                    "xml": "<message><body>people people</body></message>",
                    "kind": "groupchat",
                    "origin_id": "msg-good",
                },
                {
                    "archive_id": 103,
                    "username": None,
                    "timestamp": None,
                    "peer": None,
                    "bare_peer": None,
                    "txt": None,
                    "xml": None,
                    "kind": None,
                    "origin_id": None,
                },
            ]
        )
        with patch.object(
            message_service.database,
            "connection",
            side_effect=lambda *args, **kwargs: fake_connection(
                group_cursor if not kwargs.get("database_name") else archive_cursor
            ),
        ):
            results = message_service.search_messages(
                current_jid="t1.owner@v1.chat.rediff.com",
                tenant_slug="t1",
                vhost="v1.chat.rediff.com",
                q="people",
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].archive_id, 102)


if __name__ == "__main__":
    unittest.main()
