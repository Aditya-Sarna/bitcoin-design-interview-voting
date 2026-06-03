import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { CATEGORIES } from "./seed-data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "voting.db");

if (!existsSync(dbPath)) {
  console.log("No database found — seeding…");
  const result = spawnSync("node", ["seed.js"], { cwd: __dirname, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const db = new Database(dbPath);
const app = express();
const PORT = process.env.PORT || 3847;
const MAX_VOTES = 10;

try {
  db.prepare("SELECT proposed_by FROM questions LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE questions ADD COLUMN proposed_by TEXT");
}

app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(express.static(join(__dirname, "public")));

function rowToQuestion(row, voterId) {
  const voteCount = db.prepare("SELECT COUNT(*) as c FROM votes WHERE question_id = ?").get(row.id).c;
  const userVoted = voterId
    ? !!db.prepare("SELECT 1 FROM votes WHERE question_id = ? AND voter_id = ?").get(row.id, voterId)
    : false;
  const commentCount = db.prepare("SELECT COUNT(*) as c FROM comments WHERE question_id = ?").get(row.id).c;

  return {
    id: row.id,
    num: row.num,
    category: row.category,
    text: row.text,
    intention: row.intention,
    subThemes: row.sub_themes,
    directional: row.directional,
    probes: JSON.parse(row.probes || "[]"),
    proposed: !!row.proposed,
    proposedBy: row.proposed_by || null,
    canDelete: !row.proposed || !row.proposed_by || row.proposed_by === voterId,
    voteCount,
    userVoted,
    commentCount,
    createdAt: row.created_at,
  };
}

app.get("/api/meta", (_req, res) => {
  res.json({ categories: CATEGORIES, maxVotes: MAX_VOTES });
});

function sortQuestions(rows) {
  return rows.sort((a, b) => {
    if (a.proposed !== b.proposed) return b.proposed - a.proposed;
    if (a.proposed && b.proposed) {
      return new Date(b.created_at) - new Date(a.created_at);
    }
    return a.num - b.num;
  });
}

app.get("/api/questions", (req, res) => {
  const voterId = req.query.voterId || "";
  const category = req.query.category || "all";
  let rows = db.prepare("SELECT * FROM questions").all();
  if (category !== "all") rows = rows.filter((r) => r.category === category);
  rows = sortQuestions(rows);
  res.json(rows.map((r) => rowToQuestion(r, voterId)));
});

app.get("/api/dashboard", (_req, res) => {
  const top = db
    .prepare(
      `
    SELECT q.*, COUNT(v.id) as vote_count
    FROM questions q
    LEFT JOIN votes v ON v.question_id = q.id
    GROUP BY q.id
    ORDER BY vote_count DESC, q.num ASC
    LIMIT 15
  `
    )
    .all();

  const byCategory = db
    .prepare(
      `
    SELECT q.category, COUNT(v.id) as votes
    FROM questions q
    LEFT JOIN votes v ON v.question_id = q.id
    GROUP BY q.category
  `
    )
    .all();

  const totals = {
    questions: db.prepare("SELECT COUNT(*) as c FROM questions").get().c,
    votes: db.prepare("SELECT COUNT(*) as c FROM votes").get().c,
    comments: db.prepare("SELECT COUNT(*) as c FROM comments").get().c,
    voters: db.prepare("SELECT COUNT(DISTINCT voter_id) as c FROM votes").get().c,
    proposed: db.prepare("SELECT COUNT(*) as c FROM questions WHERE proposed = 1").get().c,
  };

  res.json({
    totals,
    byCategory,
    top: top.map((r) => ({
      id: r.id,
      num: r.num,
      category: r.category,
      text: r.text,
      voteCount: r.vote_count,
      proposed: !!r.proposed,
    })),
  });
});

app.post("/api/votes", (req, res) => {
  const { questionId, voterId } = req.body;
  if (!questionId || !voterId) return res.status(400).json({ error: "questionId and voterId required" });

  const q = db.prepare("SELECT id FROM questions WHERE id = ?").get(questionId);
  if (!q) return res.status(404).json({ error: "Question not found" });

  const existing = db.prepare("SELECT id FROM votes WHERE question_id = ? AND voter_id = ?").get(questionId, voterId);
  if (existing) return res.status(409).json({ error: "Already voted" });

  const used = db.prepare("SELECT COUNT(*) as c FROM votes WHERE voter_id = ?").get(voterId).c;
  if (used >= MAX_VOTES) return res.status(403).json({ error: "Vote limit reached", maxVotes: MAX_VOTES });

  db.prepare("INSERT INTO votes (question_id, voter_id) VALUES (?, ?)").run(questionId, voterId);
  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId);
  res.json({ ok: true, question: rowToQuestion(row, voterId), votesRemaining: MAX_VOTES - used - 1 });
});

app.delete("/api/votes", (req, res) => {
  const { questionId, voterId } = req.body;
  if (!questionId || !voterId) return res.status(400).json({ error: "questionId and voterId required" });

  const result = db.prepare("DELETE FROM votes WHERE question_id = ? AND voter_id = ?").run(questionId, voterId);
  if (result.changes === 0) return res.status(404).json({ error: "Vote not found" });

  const used = db.prepare("SELECT COUNT(*) as c FROM votes WHERE voter_id = ?").get(voterId).c;
  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId);
  res.json({ ok: true, question: rowToQuestion(row, voterId), votesRemaining: MAX_VOTES - used });
});

app.get("/api/votes/me", (req, res) => {
  const voterId = req.query.voterId;
  if (!voterId) return res.status(400).json({ error: "voterId required" });

  const votes = db
    .prepare(
      `
    SELECT v.question_id, v.created_at, q.text, q.num, q.category
    FROM votes v
    JOIN questions q ON q.id = v.question_id
    WHERE v.voter_id = ?
    ORDER BY v.created_at DESC
  `
    )
    .all(voterId);

  res.json({ votes, votesRemaining: MAX_VOTES - votes.length, maxVotes: MAX_VOTES });
});

app.post("/api/questions", (req, res) => {
  const { text, category, voterId, intention } = req.body;
  if (!text?.trim() || !category || !voterId) {
    return res.status(400).json({ error: "text, category, and voterId required" });
  }
  if (!CATEGORIES.some((c) => c.id === category)) {
    return res.status(400).json({ error: "Invalid category" });
  }

  const id = `prop-${Date.now()}`;
  const maxNum = db.prepare("SELECT MAX(num) as m FROM questions").get().m || 0;

  db.prepare(
    `
    INSERT INTO questions (id, num, category, text, intention, sub_themes, directional, probes, proposed, proposed_by)
    VALUES (?, ?, ?, ?, ?, '', '', '[]', 1, ?)
  `
  ).run(id, maxNum + 1, category, text.trim(), intention?.trim() || "Community-proposed question.", voterId);

  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
  res.status(201).json({ ok: true, question: rowToQuestion(row, voterId) });
});

app.delete("/api/questions/:id", (req, res) => {
  const { voterId } = req.body;
  if (!voterId) return res.status(400).json({ error: "voterId required" });

  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Question not found" });

  if (row.proposed && row.proposed_by && row.proposed_by !== voterId) {
    return res.status(403).json({ error: "Only the person who proposed this question can delete it" });
  }

  const deleteQuestion = db.transaction((questionId) => {
    db.prepare("DELETE FROM comments WHERE question_id = ?").run(questionId);
    db.prepare("DELETE FROM votes WHERE question_id = ?").run(questionId);
    db.prepare("DELETE FROM questions WHERE id = ?").run(questionId);
  });

  deleteQuestion(row.id);
  res.json({ ok: true, id: row.id });
});

app.get("/api/comments/:questionId", (req, res) => {
  const comments = db
    .prepare(
      `
    SELECT id, question_id, voter_id, author_label, body, created_at
    FROM comments WHERE question_id = ?
    ORDER BY created_at DESC
  `
    )
    .all(req.params.questionId);

  res.json(comments.map((c) => ({
    id: c.id,
    questionId: c.question_id,
    authorLabel: c.author_label || "Anonymous",
    body: c.body,
    createdAt: c.created_at,
  })));
});

app.post("/api/comments", (req, res) => {
  const { questionId, voterId, body, authorLabel } = req.body;
  if (!questionId || !voterId || !body?.trim()) {
    return res.status(400).json({ error: "questionId, voterId, and body required" });
  }

  const q = db.prepare("SELECT id FROM questions WHERE id = ?").get(questionId);
  if (!q) return res.status(404).json({ error: "Question not found" });

  const result = db
    .prepare("INSERT INTO comments (question_id, voter_id, author_label, body) VALUES (?, ?, ?, ?)")
    .run(questionId, voterId, (authorLabel || "").trim().slice(0, 40), body.trim().slice(0, 500));

  res.status(201).json({
    ok: true,
    comment: {
      id: result.lastInsertRowid,
      questionId,
      authorLabel: (authorLabel || "").trim() || "Anonymous",
      body: body.trim(),
    },
  });
});

app.listen(PORT, () => {
  console.log(`Interview voting board: http://localhost:${PORT}`);
});
