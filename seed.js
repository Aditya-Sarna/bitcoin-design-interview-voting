import Database from "better-sqlite3";
import { QUESTIONS, CATEGORIES } from "./seed-data.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "voting.db");

const db = new Database(dbPath);

db.exec(`
  DROP TABLE IF EXISTS comments;
  DROP TABLE IF EXISTS votes;
  DROP TABLE IF EXISTS questions;

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    num INTEGER NOT NULL,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    intention TEXT,
    sub_themes TEXT,
    directional TEXT,
    probes TEXT,
    proposed INTEGER DEFAULT 0,
    proposed_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(question_id, voter_id),
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    author_label TEXT,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );

  CREATE INDEX idx_votes_question ON votes(question_id);
  CREATE INDEX idx_votes_voter ON votes(voter_id);
  CREATE INDEX idx_comments_question ON comments(question_id);
`);

const insert = db.prepare(`
  INSERT INTO questions (id, num, category, text, intention, sub_themes, directional, probes, proposed)
  VALUES (@id, @num, @category, @text, @intention, @sub_themes, @directional, @probes, @proposed)
`);

const insertMany = db.transaction((rows) => {
  for (const row of rows) insert.run(row);
});

insertMany(
  QUESTIONS.map((q) => ({
    id: `q${q.num}`,
    num: q.num,
    category: q.category,
    text: q.text,
    intention: q.intention || "",
    sub_themes: q.subThemes || "",
    directional: q.directional || "",
    probes: JSON.stringify(q.probes || []),
    proposed: 0,
  }))
);

console.log(`Seeded ${QUESTIONS.length} questions across ${CATEGORIES.length} categories.`);
console.log(`Database: ${dbPath}`);
db.close();
