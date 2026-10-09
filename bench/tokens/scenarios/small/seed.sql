PRAGMA user_version=5;
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE items(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
  parent TEXT, description TEXT, assignee TEXT, due TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), priority TEXT NOT NULL DEFAULT 'p2', type TEXT NOT NULL DEFAULT 'feature', lease_at TEXT, note TEXT, section TEXT);
INSERT INTO items VALUES('E1','epic','String utilities','todo',NULL,'Add three small utilities to textkit, each exported from src/index.js.',NULL,NULL,'2026-10-09T21:35:31Z','2026-10-09T21:35:31Z','p2','feature',NULL,NULL,NULL);
INSERT INTO items VALUES('T1','task','slugify','todo','E1','Add slugify(text) in src/slugify.js.',NULL,NULL,'2026-10-09T21:35:31Z','2026-10-09T21:35:31Z','p2','feature',NULL,NULL,NULL);
INSERT INTO items VALUES('T2','task','truncate','todo','E1','Add truncate(text, max, ellipsis = ''…'') in src/truncate.js.',NULL,NULL,'2026-10-09T21:35:31Z','2026-10-09T21:35:31Z','p2','feature',NULL,NULL,NULL);
INSERT INTO items VALUES('T3','task','CLI','todo','E1','Add bin/textkit.js (blocked by T1 and T2).',NULL,NULL,'2026-10-09T21:35:31Z','2026-10-09T21:35:31Z','p2','feature',NULL,NULL,NULL);
CREATE TABLE counters(prefix TEXT PRIMARY KEY, n INTEGER NOT NULL);
INSERT INTO counters VALUES('E',1);
INSERT INTO counters VALUES('T',3);
CREATE TABLE activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, author TEXT NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), undo TEXT, redo TEXT, op INTEGER, undone INTEGER, reverts INTEGER);
INSERT INTO activity VALUES(1,'E1','claude','create','created epic “String utilities”','2026-10-09T21:35:31Z',NULL,NULL,1,NULL,NULL);
INSERT INTO activity VALUES(2,'T1','claude','create','created task “slugify”','2026-10-09T21:35:31Z',NULL,NULL,2,NULL,NULL);
INSERT INTO activity VALUES(3,'T2','claude','create','created task “truncate”','2026-10-09T21:35:31Z',NULL,NULL,3,NULL,NULL);
INSERT INTO activity VALUES(4,'T3','claude','create','created task “CLI”','2026-10-09T21:35:31Z',NULL,NULL,4,NULL,NULL);
INSERT INTO activity VALUES(5,'T1','claude','edit','checklist set (3 items)','2026-10-09T21:35:31Z',unistr('SELECT CASE WHEN NOT (COALESCE((SELECT group_concat(text, char(30)) FROM (SELECT text FROM checks WHERE item_id=''T1'' ORDER BY n)), '''') = ''Lowercases, strips accents (é→e), turns runs of non-alphanumerics into one hyphen, trims leading/trailing hyphens\u001eExported from src/index.js\u001eTests in test/slugify.test.js pass with npm test'') THEN json_extract(''{}'', ''!T1''''s checklist has changed since; change it directly'') END;\u000aDELETE FROM checks WHERE item_id=''T1'';\u000a\u000aUPDATE items SET updated_at=strftime(''%Y-%m-%dT%H:%M:%SZ'',''now'') WHERE id=''T1'';'),unistr('SELECT CASE WHEN NOT (COALESCE((SELECT group_concat(text, char(30)) FROM (SELECT text FROM checks WHERE item_id=''T1'' ORDER BY n)), '''') = '''') THEN json_extract(''{}'', ''!T1''''s checklist has changed since; change it directly'') END;\u000aDELETE FROM checks WHERE item_id=''T1'';\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T1'', 1, ''Lowercases, strips accents (é→e), turns runs of non-alphanumerics into one hyphen, trims leading/trailing hyphens'', 0);\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T1'', 2, ''Exported from src/index.js'', 0);\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T1'', 3, ''Tests in test/slugify.test.js pass with npm test'', 0);\u000aUPDATE items SET updated_at=strftime(''%Y-%m-%dT%H:%M:%SZ'',''now'') WHERE id=''T1'';'),5,NULL,NULL);
INSERT INTO activity VALUES(6,'T2','claude','edit','checklist set (3 items)','2026-10-09T21:35:31Z',unistr('SELECT CASE WHEN NOT (COALESCE((SELECT group_concat(text, char(30)) FROM (SELECT text FROM checks WHERE item_id=''T2'' ORDER BY n)), '''') = ''Returns text unchanged when it fits in max characters\u001eOtherwise cuts at the last word boundary so the result including the ellipsis is at most max characters (hard cut if there is no boundary)\u001eExported from src/index.js, with tests in test/truncate.test.js passing'') THEN json_extract(''{}'', ''!T2''''s checklist has changed since; change it directly'') END;\u000aDELETE FROM checks WHERE item_id=''T2'';\u000a\u000aUPDATE items SET updated_at=strftime(''%Y-%m-%dT%H:%M:%SZ'',''now'') WHERE id=''T2'';'),unistr('SELECT CASE WHEN NOT (COALESCE((SELECT group_concat(text, char(30)) FROM (SELECT text FROM checks WHERE item_id=''T2'' ORDER BY n)), '''') = '''') THEN json_extract(''{}'', ''!T2''''s checklist has changed since; change it directly'') END;\u000aDELETE FROM checks WHERE item_id=''T2'';\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T2'', 1, ''Returns text unchanged when it fits in max characters'', 0);\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T2'', 2, ''Otherwise cuts at the last word boundary so the result including the ellipsis is at most max characters (hard cut if there is no boundary)'', 0);\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T2'', 3, ''Exported from src/index.js, with tests in test/truncate.test.js passing'', 0);\u000aUPDATE items SET updated_at=strftime(''%Y-%m-%dT%H:%M:%SZ'',''now'') WHERE id=''T2'';'),6,NULL,NULL);
INSERT INTO activity VALUES(7,'T3','claude','edit','blocked by T1','2026-10-09T21:35:31Z','DELETE FROM links WHERE blocker=''T1'' AND blocked=''T3'';','INSERT OR IGNORE INTO links(blocker, blocked) VALUES (''T1'', ''T3'');',7,NULL,NULL);
INSERT INTO activity VALUES(8,'T3','claude','edit','blocked by T2','2026-10-09T21:35:31Z','DELETE FROM links WHERE blocker=''T2'' AND blocked=''T3'';','INSERT OR IGNORE INTO links(blocker, blocked) VALUES (''T2'', ''T3'');',7,NULL,NULL);
INSERT INTO activity VALUES(9,'T3','claude','edit','checklist set (4 items)','2026-10-09T21:35:31Z',unistr('SELECT CASE WHEN NOT (COALESCE((SELECT group_concat(text, char(30)) FROM (SELECT text FROM checks WHERE item_id=''T3'' ORDER BY n)), '''') = ''`node bin/textkit.js slugify <text>` and `node bin/textkit.js truncate <max> <text>` print the result; unknown command prints usage and exits 1\u001epackage.json has a "bin" entry for textkit\u001eTests in test/cli.test.js run the CLI via child_process and pass\u001eREADME.md has a Usage section'') THEN json_extract(''{}'', ''!T3''''s checklist has changed since; change it directly'') END;\u000aDELETE FROM checks WHERE item_id=''T3'';\u000a\u000aUPDATE items SET updated_at=strftime(''%Y-%m-%dT%H:%M:%SZ'',''now'') WHERE id=''T3'';'),unistr('SELECT CASE WHEN NOT (COALESCE((SELECT group_concat(text, char(30)) FROM (SELECT text FROM checks WHERE item_id=''T3'' ORDER BY n)), '''') = '''') THEN json_extract(''{}'', ''!T3''''s checklist has changed since; change it directly'') END;\u000aDELETE FROM checks WHERE item_id=''T3'';\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T3'', 1, ''`node bin/textkit.js slugify <text>` and `node bin/textkit.js truncate <max> <text>` print the result; unknown command prints usage and exits 1'', 0);\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T3'', 2, ''package.json has a "bin" entry for textkit'', 0);\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T3'', 3, ''Tests in test/cli.test.js run the CLI via child_process and pass'', 0);\u000aINSERT INTO checks(item_id, n, text, done) VALUES (''T3'', 4, ''README.md has a Usage section'', 0);\u000aUPDATE items SET updated_at=strftime(''%Y-%m-%dT%H:%M:%SZ'',''now'') WHERE id=''T3'';'),9,NULL,NULL);
CREATE TABLE links(blocker TEXT NOT NULL, blocked TEXT NOT NULL, PRIMARY KEY (blocker, blocked));
INSERT INTO links VALUES('T1','T3');
INSERT INTO links VALUES('T2','T3');
CREATE TABLE checks(item_id TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (item_id, n));
INSERT INTO checks VALUES('T1',1,'Lowercases, strips accents (é→e), turns runs of non-alphanumerics into one hyphen, trims leading/trailing hyphens',0);
INSERT INTO checks VALUES('T1',2,'Exported from src/index.js',0);
INSERT INTO checks VALUES('T1',3,'Tests in test/slugify.test.js pass with npm test',0);
INSERT INTO checks VALUES('T2',1,'Returns text unchanged when it fits in max characters',0);
INSERT INTO checks VALUES('T2',2,'Otherwise cuts at the last word boundary so the result including the ellipsis is at most max characters (hard cut if there is no boundary)',0);
INSERT INTO checks VALUES('T2',3,'Exported from src/index.js, with tests in test/truncate.test.js passing',0);
INSERT INTO checks VALUES('T3',1,'`node bin/textkit.js slugify <text>` and `node bin/textkit.js truncate <max> <text>` print the result; unknown command prints usage and exits 1',0);
INSERT INTO checks VALUES('T3',2,'package.json has a "bin" entry for textkit',0);
INSERT INTO checks VALUES('T3',3,'Tests in test/cli.test.js run the CLI via child_process and pass',0);
INSERT INTO checks VALUES('T3',4,'README.md has a Usage section',0);
CREATE TABLE reads(reader TEXT NOT NULL, item_id TEXT NOT NULL, seen INTEGER NOT NULL,
  PRIMARY KEY (reader, item_id));
CREATE TABLE labels(item_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (item_id, label));
CREATE TABLE relations(a TEXT NOT NULL, b TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (a, b, type));
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('activity',9);
CREATE INDEX activity_item ON activity(item_id);
COMMIT;
