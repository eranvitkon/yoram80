const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { notifyNewPhoto } = require('./mailer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'eran@example.com';
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('קבצי תמונה בלבד'));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  secret: process.env.SESSION_SECRET || 'yoram80-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'נדרשת כניסה לחשבון' });
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(403).json({ error: 'אין הרשאת אדמין' });
}

// ─── Auth routes ─────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'כל השדות חובה' });
  if (password.length < 6)
    return res.status(400).json({ error: 'סיסמה חייבת להיות לפחות 6 תווים' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 1 : 0;
    const stmt = db.prepare('INSERT INTO users (name, email, password_hash, is_admin) VALUES (?, ?, ?, ?)');
    const result = stmt.run(name, email.toLowerCase(), hash, isAdmin);
    req.session.userId = result.lastInsertRowid;
    req.session.userName = name;
    req.session.isAdmin = isAdmin === 1;
    res.json({ success: true, name, isAdmin: isAdmin === 1 });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'כתובת המייל כבר רשומה' });
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'כל השדות חובה' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'פרטים שגויים' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'פרטים שגויים' });

  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = user.is_admin === 1;
  res.json({ success: true, name: user.name, isAdmin: user.is_admin === 1 });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: req.session.userName, isAdmin: req.session.isAdmin, userId: req.session.userId });
});

// ─── Photos routes ────────────────────────────────────────────────────────────

app.get('/api/photos', (req, res) => {
  const photos = db.prepare(`
    SELECT p.*, u.name as uploader_name,
      (SELECT COUNT(*) FROM likes WHERE photo_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM comments WHERE photo_id = p.id) as comments_count
    FROM photos p
    JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC
  `).all();
  res.json(photos);
});

app.post('/api/photos', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחרה תמונה' });
  const { caption, event_tag } = req.body;
  if (!event_tag) return res.status(400).json({ error: 'נא לבחור אירוע' });

  const result = db.prepare('INSERT INTO photos (user_id, filename, caption, event_tag) VALUES (?, ?, ?, ?)')
    .run(req.session.userId, req.file.filename, caption || '', event_tag);

  const photo = db.prepare(`
    SELECT p.*, u.name as uploader_name, 0 as likes_count, 0 as comments_count
    FROM photos p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(result.lastInsertRowid);

  broadcast({ type: 'new_photo', photo });

  const allUsers = db.prepare('SELECT email, name FROM users').all();
  notifyNewPhoto(req.session.userName, result.lastInsertRowid, allUsers);

  res.json({ success: true, photo });
});

app.delete('/api/photos/:id', requireAdmin, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'תמונה לא נמצאה' });

  const filePath = path.join(uploadsDir, photo.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM likes WHERE photo_id = ?').run(req.params.id);
  db.prepare('DELETE FROM comments WHERE photo_id = ?').run(req.params.id);
  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);

  broadcast({ type: 'delete_photo', photoId: parseInt(req.params.id) });
  res.json({ success: true });
});

// ─── Likes routes ─────────────────────────────────────────────────────────────

app.post('/api/photos/:id/like', requireAuth, (req, res) => {
  const photoId = req.params.id;
  const userId = req.session.userId;
  try {
    db.prepare('INSERT INTO likes (user_id, photo_id) VALUES (?, ?)').run(userId, photoId);
    const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE photo_id = ?').get(photoId).c;
    broadcast({ type: 'like_update', photoId: parseInt(photoId), count });
    res.json({ liked: true, count });
  } catch {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND photo_id = ?').run(userId, photoId);
    const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE photo_id = ?').get(photoId).c;
    broadcast({ type: 'like_update', photoId: parseInt(photoId), count });
    res.json({ liked: false, count });
  }
});

app.get('/api/photos/:id/liked', requireAuth, (req, res) => {
  const like = db.prepare('SELECT id FROM likes WHERE user_id = ? AND photo_id = ?').get(req.session.userId, req.params.id);
  res.json({ liked: !!like });
});

// ─── Comments routes ──────────────────────────────────────────────────────────

app.get('/api/photos/:id/comments', (req, res) => {
  const comments = db.prepare(`
    SELECT c.*, u.name as commenter_name
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.photo_id = ? ORDER BY c.created_at ASC
  `).all(req.params.id);
  res.json(comments);
});

app.post('/api/photos/:id/comments', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'תגובה ריקה' });
  const result = db.prepare('INSERT INTO comments (user_id, photo_id, content) VALUES (?, ?, ?)')
    .run(req.session.userId, req.params.id, content.trim());
  const comment = db.prepare('SELECT c.*, u.name as commenter_name FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?').get(result.lastInsertRowid);
  broadcast({ type: 'new_comment', comment });
  res.json({ success: true, comment });
});

app.delete('/api/comments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  broadcast({ type: 'delete_comment', commentId: parseInt(req.params.id) });
  res.json({ success: true });
});

// ─── Memories routes ──────────────────────────────────────────────────────────

app.get('/api/memories', (req, res) => {
  const memories = db.prepare(`
    SELECT m.*, u.name as author_name
    FROM memories m JOIN users u ON m.user_id = u.id
    ORDER BY m.created_at DESC
  `).all();
  res.json(memories);
});

app.post('/api/memories', requireAuth, (req, res) => {
  const { content, event_tag } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'תוכן ריק' });
  if (!event_tag) return res.status(400).json({ error: 'נא לבחור אירוע' });
  const result = db.prepare('INSERT INTO memories (user_id, content, event_tag) VALUES (?, ?, ?)')
    .run(req.session.userId, content.trim(), event_tag);
  const memory = db.prepare('SELECT m.*, u.name as author_name FROM memories m JOIN users u ON m.user_id = u.id WHERE m.id = ?').get(result.lastInsertRowid);
  broadcast({ type: 'new_memory', memory });
  res.json({ success: true, memory });
});

app.delete('/api/memories/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ?').run(req.params.id);
  broadcast({ type: 'delete_memory', memoryId: parseInt(req.params.id) });
  res.json({ success: true });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// ─── Catch-all → index.html ───────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`🎂 יום הולדת 80 לסבא יורם — שרת פעיל על פורט ${PORT}`);
});
