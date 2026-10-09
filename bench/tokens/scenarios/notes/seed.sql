PRAGMA user_version=5;
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE items(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
  parent TEXT, description TEXT, assignee TEXT, due TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), priority TEXT NOT NULL DEFAULT 'p2', type TEXT NOT NULL DEFAULT 'feature', lease_at TEXT, note TEXT, section TEXT);
CREATE TABLE counters(prefix TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, author TEXT NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), undo TEXT, redo TEXT, op INTEGER, undone INTEGER, reverts INTEGER);
CREATE TABLE links(blocker TEXT NOT NULL, blocked TEXT NOT NULL, PRIMARY KEY (blocker, blocked));
CREATE TABLE checks(item_id TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (item_id, n));
CREATE TABLE reads(reader TEXT NOT NULL, item_id TEXT NOT NULL, seen INTEGER NOT NULL,
  PRIMARY KEY (reader, item_id));
CREATE TABLE labels(item_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (item_id, label));
CREATE TABLE relations(a TEXT NOT NULL, b TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (a, b, type));
CREATE INDEX activity_item ON activity(item_id);
INSERT INTO items VALUES('E1','epic','Notes API v2','todo',NULL,'Make notes durable, findable and exportable. Each task touches several files of the existing app (src/, test/, README.md).',NULL,NULL,'2026-10-09T00:00:00Z','2026-10-09T00:00:00Z','p2','feature',NULL,NULL,NULL);
INSERT INTO items VALUES('T1','task','File persistence','todo','E1','Add a FileStore beside MemoryStore in src/store.js, with the same interface, that keeps notes in a JSON file.',NULL,NULL,'2026-10-09T00:00:00Z','2026-10-09T00:00:00Z','p2','feature',NULL,NULL,NULL);
INSERT INTO checks VALUES('T1',1,'FileStore.open(path) loads existing notes (or starts empty when the file is missing) and every change is written atomically (temp file, then rename)',0);
INSERT INTO checks VALUES('T1',2,'src/main.js uses FileStore when NOTES_FILE is set, else MemoryStore',0);
INSERT INTO checks VALUES('T1',3,'test/store.test.js: notes survive closing and reopening the store, no temp file is left behind, and the server tests also pass against a FileStore',0);
INSERT INTO checks VALUES('T1',4,'README.md documents NOTES_FILE',0);
INSERT INTO items VALUES('T2','task','Tags and search','todo','E1','Notes gain tags, and GET /notes can filter by tag and search text.',NULL,NULL,'2026-10-09T00:00:00Z','2026-10-09T00:00:00Z','p2','feature',NULL,NULL,NULL);
INSERT INTO checks VALUES('T2',1,'Notes have tags: an array of up to 10 lowercase strings matching [a-z0-9-]{1,30}, validated on POST and PATCH in src/validate.js and kept by both stores',0);
INSERT INTO checks VALUES('T2',2,'GET /notes?tag=x returns notes carrying tag x; ?q=text matches title or body case-insensitively; the two combine',0);
INSERT INTO checks VALUES('T2',3,'An invalid tag or an empty q is a 400 with a message',0);
INSERT INTO checks VALUES('T2',4,'test/tags.test.js covers tags, filters and errors; README.md documents them',0);
INSERT INTO items VALUES('T3','task','Pagination and export','todo','E1','Page through GET /notes, and export notes as Markdown from the command line.',NULL,NULL,'2026-10-09T00:00:00Z','2026-10-09T00:00:00Z','p2','feature',NULL,NULL,NULL);
INSERT INTO checks VALUES('T3',1,'GET /notes takes limit (1-100, default 20) and offset (0 or more, default 0), applied after the filters, and sets an X-Total-Count header with the filtered total; bad values are a 400',0);
INSERT INTO checks VALUES('T3',2,'bin/export.js: `node bin/export.js <notes-file> [--tag x]` prints the file''s notes newest first as Markdown (## title, the body, then a Tags: line); package.json has a bin entry for it',0);
INSERT INTO checks VALUES('T3',3,'test/pagination.test.js and test/export.test.js cover both',0);
INSERT INTO checks VALUES('T3',4,'README.md documents pagination and the export command',0);
INSERT INTO links VALUES('T1','T3');
INSERT INTO links VALUES('T2','T3');
INSERT INTO counters VALUES('E',1);
INSERT INTO counters VALUES('T',3);
COMMIT;
