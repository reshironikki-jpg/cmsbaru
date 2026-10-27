const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Menangani newline pada private key di environment variable:
// buang kutip yang sering ikut terpaste, buang CR (\r), dan ubah \n teks menjadi newline asli
const rawKey = process.env.FIREBASE_PRIVATE_KEY;
const cleanedKey = rawKey
  ? rawKey.replace(/^\u0022|^\u0027|\u0022$|\u0027$/g, '').replace(/\r/g, '').replace(/\\n/g, '\n')
  : undefined;

// Inisialisasi Firebase Admin SDK
// Di Vercel, kredensial bisa dimasukkan via Environment Variables
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: cleanedKey,
    }),
  });
}

const db = admin.firestore();

// Middleware untuk menyajikan file statis dari folder 'public' (agar index.html bisa diakses di root '/')
// HTML dilayani tanpa cache supaya browser selalu memuat versi frontend terbaru
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// Endpoint diagnosa: buka sekali di URL deployment untuk melihat status env dan
// tes koneksinya langsung. TIDAK menampilkan nilai rahasia, hanya set/kosong + panjang.
app.get('/api/health', async (req, res) => {
  const st = (v) => (v ? `set (${v.length} char)` : 'KOSONG');
  const pk = process.env.FIREBASE_PRIVATE_KEY || '';
  let firestore = 'ok';
  try {
    await db.collection('posts').limit(1).get();
  } catch (e) {
    firestore = e.message;
  }
  res.json({
    FIREBASE_PROJECT_ID: st(process.env.FIREBASE_PROJECT_ID),
    FIREBASE_CLIENT_EMAIL: st(process.env.FIREBASE_CLIENT_EMAIL),
    FIREBASE_PRIVATE_KEY: ppt(pk),
    firestoreTest: firestore,
    nodeEnv: process.env.NODE_ENV || 'dev',
  });
});

function ppt(pk) {
  if (!pk) return 'KOSONG';
  const info = [];
  info.push('set (' + pk.length + ' char)');
  info.push(pk.includes('\n') ? 'newline-asli' : 'newline-asli: TIDAK');
  info.push(pk.includes('\\n') ? 'teks-\\n ada' : 'teks-\\n: tidak');
  return info.join('; ');
}
app.get('/api/posts', async (req, res) => {
  try {
    const snapshot = await db.collection('posts').orderBy('createdAt', 'desc').get();
    const posts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(posts);
  } catch (error) {
    console.error('GET /api/posts gagal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route Contoh: Menambah Konten Baru
app.post('/api/posts', async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Judul dan konten wajib diisi' });
    }
    const newPost = { title, content, createdAt: new Date().toISOString() };
    const docRef = await db.collection('posts').add(newPost);
    res.status(201).json({ id: docRef.id, ...newPost });
  } catch (error) {
    console.error('POST /api/posts gagal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export untuk Vercel Serverless Function
module.exports = app;

// Jalankan server lokal jika tidak di Vercel
if (process.env.NODE_ENV !== 'production') {
  // Guard: PORT=0/NaN/empty memicu port acak di Node; jadikan 3000 sebagai fallback
  const rawPort = Number(process.env.PORT);
  const PORT = rawPort > 0 && Number.isFinite(rawPort) ? rawPort : 3000;
  app.listen(PORT, () => {
    console.log(`Server CMS berjalan di http://localhost:${PORT}`);
  });
}