const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { notifyNewPhoto } = require('./mailer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('תמונות בלבד'))
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  secret: process.env.SESSION_SECRET || 'yoram80-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const clients = new Set();
wss.on('connection', ws => { clients.add(ws); ws.on('close', () => clients.delete(ws)); });
function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}
function requireAuth(req, res, next) { if (req.session.userId) return next(); res.status(401).json({ error: 'נדרשת כניסה' }); }
function requireAdmin(req, res, next) { if (req.session.isAdmin) return next(); res.status(403).json({ error: 'אין הרשאה' }); }

// ── Secret admin ──────────────────────────────────────────────────────────────
app.get('/eran', (req, res) => {
  req.session.isAdmin = true;
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'נא למלא שם ומייל' });
  const emailLower = email.toLowerCase().trim();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailLower);
  if (!user) {
    const r = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(name.trim(), emailLower);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  }
  req.session.userId = user.id;
  req.session.userName = user.name;
  if (!req.session.isAdmin) req.session.isAdmin = false;
  res.json({ success: true, name: user.name, isAdmin: req.session.isAdmin });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: req.session.userName, isAdmin: req.session.isAdmin || false, userId: req.session.userId });
});

// ── Activity reactions ────────────────────────────────────────────────────────
app.get('/api/reactions', (req, res) => {
  const rows = db.prepare(`
    SELECT activity_id, emoji, COUNT(*) as count
    FROM activity_reactions GROUP BY activity_id, emoji
  `).all();
  // group by activity_id => { emoji: count }
  const result = {};
  rows.forEach(r => {
    if (!result[r.activity_id]) result[r.activity_id] = {};
    result[r.activity_id][r.emoji] = r.count;
  });
  res.json(result);
});

app.get('/api/reactions/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT activity_id, emoji FROM activity_reactions WHERE user_id = ?').all(req.session.userId);
  const result = {};
  rows.forEach(r => { result[r.activity_id] = r.emoji; });
  res.json(result);
});

app.post('/api/reactions/:activityId', requireAuth, (req, res) => {
  const { activityId } = req.params;
  const { emoji } = req.body;
  const ALLOWED = ['❤️','🔥','😂','👏','🤩','😍','🙌','💪'];
  if (!ALLOWED.includes(emoji)) return res.status(400).json({ error: 'אימוג\'י לא חוקי' });

  const existing = db.prepare('SELECT * FROM activity_reactions WHERE user_id = ? AND activity_id = ?').get(req.session.userId, activityId);

  if (existing && existing.emoji === emoji) {
    // toggle off
    db.prepare('DELETE FROM activity_reactions WHERE user_id = ? AND activity_id = ?').run(req.session.userId, activityId);
  } else if (existing) {
    // change emoji
    db.prepare('UPDATE activity_reactions SET emoji = ? WHERE user_id = ? AND activity_id = ?').run(emoji, req.session.userId, activityId);
  } else {
    db.prepare('INSERT INTO activity_reactions (user_id, activity_id, emoji) VALUES (?, ?, ?)').run(req.session.userId, activityId, emoji);
  }

  // return updated counts for this activity
  const counts = db.prepare('SELECT emoji, COUNT(*) as count FROM activity_reactions WHERE activity_id = ? GROUP BY emoji').all(activityId);
  const countsMap = {};
  counts.forEach(c => { countsMap[c.emoji] = c.count; });
  const myEmoji = db.prepare('SELECT emoji FROM activity_reactions WHERE user_id = ? AND activity_id = ?').get(req.session.userId, activityId);

  broadcast({ type: 'reaction_update', activityId, counts: countsMap });
  res.json({ success: true, counts: countsMap, myEmoji: myEmoji?.emoji || null });
});

// ── Photos ────────────────────────────────────────────────────────────────────
app.get('/api/photos', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, u.name as uploader_name,
      (SELECT COUNT(*) FROM likes WHERE photo_id=p.id) as likes_count,
      (SELECT COUNT(*) FROM comments WHERE photo_id=p.id) as comments_count
    FROM photos p JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC
  `).all());
});

app.post('/api/photos', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחרה תמונה' });
  const { caption, event_tag } = req.body;
  if (!event_tag) return res.status(400).json({ error: 'נא לבחור אירוע' });
  const r = db.prepare('INSERT INTO photos (user_id, filename, caption, event_tag) VALUES (?,?,?,?)').run(req.session.userId, req.file.filename, caption||'', event_tag);
  const photo = db.prepare('SELECT p.*, u.name as uploader_name, 0 as likes_count, 0 as comments_count FROM photos p JOIN users u ON p.user_id=u.id WHERE p.id=?').get(r.lastInsertRowid);
  broadcast({ type: 'new_photo', photo });
  notifyNewPhoto(req.session.userName, r.lastInsertRowid, db.prepare('SELECT email, name FROM users WHERE email IS NOT NULL').all());
  res.json({ success: true, photo });
});

app.delete('/api/photos/:id', requireAdmin, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'לא נמצא' });
  const fp = path.join(uploadsDir, photo.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM likes WHERE photo_id=?').run(req.params.id);
  db.prepare('DELETE FROM comments WHERE photo_id=?').run(req.params.id);
  db.prepare('DELETE FROM photos WHERE id=?').run(req.params.id);
  broadcast({ type: 'delete_photo', photoId: parseInt(req.params.id) });
  res.json({ success: true });
});

// ── Hero photo ────────────────────────────────────────────────────────────────
app.post('/api/admin/hero-photo', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחרה תמונה' });
  const dest = path.join(uploadsDir, 'yoram-hero.jpg');
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(req.file.path, dest);
  res.json({ success: true });
});

// ── Likes ─────────────────────────────────────────────────────────────────────
app.post('/api/photos/:id/like', requireAuth, (req, res) => {
  try {
    db.prepare('INSERT INTO likes (user_id, photo_id) VALUES (?,?)').run(req.session.userId, req.params.id);
    const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE photo_id=?').get(req.params.id).c;
    broadcast({ type: 'like_update', photoId: parseInt(req.params.id), count });
    res.json({ liked: true, count });
  } catch {
    db.prepare('DELETE FROM likes WHERE user_id=? AND photo_id=?').run(req.session.userId, req.params.id);
    const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE photo_id=?').get(req.params.id).c;
    broadcast({ type: 'like_update', photoId: parseInt(req.params.id), count });
    res.json({ liked: false, count });
  }
});

app.get('/api/photos/:id/liked', requireAuth, (req, res) => {
  res.json({ liked: !!db.prepare('SELECT id FROM likes WHERE user_id=? AND photo_id=?').get(req.session.userId, req.params.id) });
});

// ── Comments ──────────────────────────────────────────────────────────────────
app.get('/api/photos/:id/comments', (req, res) => {
  res.json(db.prepare('SELECT c.*, u.name as commenter_name FROM comments c JOIN users u ON c.user_id=u.id WHERE c.photo_id=? ORDER BY c.created_at ASC').all(req.params.id));
});

app.post('/api/photos/:id/comments', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'תגובה ריקה' });
  const r = db.prepare('INSERT INTO comments (user_id, photo_id, content) VALUES (?,?,?)').run(req.session.userId, req.params.id, content.trim());
  const comment = db.prepare('SELECT c.*, u.name as commenter_name FROM comments c JOIN users u ON c.user_id=u.id WHERE c.id=?').get(r.lastInsertRowid);
  broadcast({ type: 'new_comment', comment });
  res.json({ success: true, comment });
});

app.delete('/api/comments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id);
  broadcast({ type: 'delete_comment', commentId: parseInt(req.params.id) });
  res.json({ success: true });
});

// ── Memories ──────────────────────────────────────────────────────────────────
app.get('/api/memories', (req, res) => {
  res.json(db.prepare('SELECT m.*, u.name as author_name FROM memories m JOIN users u ON m.user_id=u.id ORDER BY m.created_at DESC').all());
});

app.post('/api/memories', requireAuth, (req, res) => {
  const { content, event_tag } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'תוכן ריק' });
  if (!event_tag) return res.status(400).json({ error: 'נא לבחור אירוע' });
  const r = db.prepare('INSERT INTO memories (user_id, content, event_tag) VALUES (?,?,?)').run(req.session.userId, content.trim(), event_tag);
  const memory = db.prepare('SELECT m.*, u.name as author_name FROM memories m JOIN users u ON m.user_id=u.id WHERE m.id=?').get(r.lastInsertRowid);
  broadcast({ type: 'new_memory', memory });
  res.json({ success: true, memory });
});

app.delete('/api/memories/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM memories WHERE id=?').run(req.params.id);
  broadcast({ type: 'delete_memory', memoryId: parseInt(req.params.id) });
  res.json({ success: true });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC').all());
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`🎂 יורם 80 — פורט ${PORT}`));
