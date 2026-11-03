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

// ==== Autentikasi Admin (HTTP Basic) ====
// Set ADMIN_USER dan ADMIN_PASSWORD di environment variables (.env lokal / Vercel)
// untuk mengaktifkan area admin. Semua route tulis & route admin dilindungi ini.
function requireAdmin(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    return res.status(503).json({ error: 'Area admin belum aktif: set ADMIN_USER dan ADMIN_PASSWORD di environment variables' });
  }
  const header = req.headers.authorization || '';
  const m = header.match(/^Basic (.+)$/);
  let ok = false;
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      ok = u === user && p === pass;
    } catch (_) { ok = false; }
  }
  if (!ok) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin area"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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
app.get('/api/posts', async (req, res) => {  // Publik: hanya postingan yang sudah dipublish
  try {
    // Filter di Firestore lalu urutkan di kode: menghindari kebutuhan composite index
    const snapshot = await db.collection('posts')
      .where('published', '==', true)
      .get();
    const posts = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.status(200).json(posts);
  } catch (error) {
    console.error('GET /api/posts gagal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: daftar SEMUA postingan (termasuk yang belum dipublish)
app.get('/api/admin/posts', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('posts').orderBy('createdAt', 'desc').get();
    const posts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(posts);
  } catch (error) {
    console.error('GET /api/admin/posts gagal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route Contoh: Menambah Konten Baru (khusus admin)
app.post('/api/posts', requireAdmin, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Judul dan konten wajib diisi' });
    }
    const newPost = { title, content, published: true, createdAt: new Date().toISOString() };
    const docRef = await db.collection('posts').add(newPost);
    res.status(201).json({ id: docRef.id, ...newPost });
  } catch (error) {
    console.error('POST /api/posts gagal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: update sebuah postingan (title/content/published — bebas kombinasi)
app.patch('/api/posts/:id', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    if (typeof body.published === 'boolean') update.published = body.published;
    if (typeof body.title === 'string' && body.title.trim()) update.title = body.title.trim();
    if (typeof body.content === 'string' && body.content.trim()) update.content = body.content.trim();
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Body harus berisi "published": true/false dan/atau "title" dan/atau "content"' });
    }
    await db.collection('posts').doc(req.params.id).update(update);
    res.status(200).json({ id: req.params.id, ...update });
  } catch (error) {
    console.error('PATCH /api/posts gagal:', error);
    if (error && error.code === 5) {  // not found
      return res.status(404).json({ error: 'Postingan tidak ditemukan' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Admin: hapus sebuah postingan
app.delete('/api/posts/:id', requireAdmin, async (req, res) => {
  try {
    await db.collection('posts').doc(req.params.id).delete();
    res.status(200).json({ id: req.params.id, deleted: true });
  } catch (error) {
    console.error('DELETE /api/posts gagal:', error);
    if (error && error.code === 5) {  // not found
      return res.status(404).json({ error: 'Postingan tidak ditemukan' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==== Auto Generate Content (100% LOKAL — TANPA API kunci) ====
// Menghasilkan judul dan artikel dari topik dengan kombinasi template kalimat bahasa
// Indonesia. Semuanya jalan di server tanpa layanan eksternal, jadi tidak butuh
// environment variable apa pun.

// Pembantu pemilihan acak sederhana
const pick1 = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pickSome = (arr, n) => arr.slice().sort(() => Math.random() - 0.5).slice(0, n);
const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const TITLE_TEMPLATES = [
  (t) => cap1(t) + ': Panduan Lengkap untuk Pemula',
  (t) => 'Mengenal ' + t + ': Manfaat, Tips, dan Penjelasannya',
  (t) => cap1(t) + ' — Hal Penting yang Perlu Anda Tahu',
  (t) => 'Tips Praktis seputar ' + t + ' yang Mudah Dipraktikkan',
  (t) => 'Apa Itu ' + t + '? Penjelasan Singkat dan Lengkapnya',
  (t) => cap1(t) + ': Dari Dasar Sampai Poin Lanjutan',
  (t) => 'Hal yang Sering Salah Dipahami tentang ' + t,
];

const INTRO_TEMPLATES = [
  (t) => cap1(t) + ' sedang menjadi salah satu topik yang paling banyak dibicarakan belakangan ini — dan memang layak, karena penerapannya dapat dirasakan langsung dalam keseharian. Artikel ini merangkum hal-hal penting seputar ' + t + ' dengan bahasa yang mudah dipahami.',
  (t) => 'Banyak orang mulai tertarik dengan ' + t + ' karena manfaatnya terasa nyata, baik bagi diri sendiri maupun lingkungan sekitar. Tulisan ini hadir sebagai panduan ringkas yang membantu Anda memahami ' + t + ' dari dasar.',
  (t) => 'Jika Anda pernah bertanya-tanya tentang ' + t + ', Anda berada di tempat yang tepat. Artikel berikut membahas definisi, manfaat, dan langkah praktisnya secara terstruktur — tanpa peristilahan berlebihan.',
];

const BODY_TEMPLATES = [
  (t) => 'Hal mendasar yang perlu dipahami tentang ' + t + ' adalah bahwa konsistensi jauh lebih menentukan hasil daripada berangkat dengan modal besar. Banyak praktisi yang memulai dari hal kecil, lalu mengembangkannya secara bertahap sesuai kebutuhan.',
  (t) => 'Dalam praktiknya, penerapan ' + t + ' tidak selalu rumit. Biasanya cukup dimulai dengan tiga langkah: menentukan tujuan yang jelas, menyiapkan alat dan waktu yang memadai, serta mengevaluasi hasil secara rutin agar bisa disesuaikan di tengah jalan.',
  (t) => 'Ada dua sudut pandang yang sering muncul ketika membahas ' + t + '. Pandangan yang pertama menekankan fleksibilitas — mengikuti arah yang paling sesuai dengan kondisi masing-masing. Pandangan kedua menekankan kerangka kerja yang terukur agar kemajuan bisa dipantau secara objektif.',
  (t) => 'Kesalahan paling umum yang terjadi adalah terlalu bersemangat di awal kemudian berhenti sebelum terbentuk kebiasaan. Solusinya cukup sederhana: bagi proses seputar ' + t + ' menjadi target kecil yang bisa dicapai setiap minggu.',
  (t) => 'Sumber belajar seputar ' + t + ' kini sangat beragam, mulai dari tulisan di internet, video, hingga komunitas yang berbagi pengalaman secara terbuka. Manfaatkan semua ini untuk mempercepat pemahaman Anda.',
  (t) => 'Dari sisi hasil, mereka yang tekun menekuni ' + t + ' umumnya melihat perubahan yang signifikan dalam hitungan minggu hingga bulan. Patience menjadi kunci — karena perubahan besar jarang terjadi dalam semalam.',
  (t) => 'Poin penting lainnya adalah menjaga keseimbangan: usahakan praktik yang sehat dan berkelanjutan, jangan lelah berlebihan, serta tetap terbuka terhadap umpan balik agar penyempurnaan berjalan terus.',
  (t) => 'Ketika teknik dasar sudah kuat, Anda bisa mengeksplorasi variasi lanjutan seputar ' + t + '. Ini membuat pengalaman tetap segar dan mendorong Anda menuju tingkat berikutnya.',
];

const POINT_TEMPLATES = [
  (t) => 'Definisi dan cakupan dasar ' + t + ' yang perlu dipahami lebih dahulu',
  (t) => 'Manfaat utama ' + t + ' dalam praktik sehari-hari',
  (t) => 'Kesalahan umum yang sebaiknya dihindari dari awal',
  (t) => 'Langkah pertama yang mudah dipraktikkan mulai hari ini',
  (t) => 'Indikator kemajuan untuk memantau perkembangan Anda',
  (t) => 'Sumber belajar dan komunitas yang layak diikuti',
];

const CLOSING_TEMPLATES = [
  (t) => 'Kesimpulannya, ' + t + ' bukan hal yang harus dianggap sulit — cukup dimulai dari langkah kecil, dilakukan secara rutin, lalu terbuka untuk perbaikan sepanjang jalan.',
  (t) => 'Pada akhirnya, yang menentukan dari penerapan ' + t + ' adalah konsistensi dan kemauan untuk terus belajar. Mulailah sekarang, sesuaikan seiring berjalan, dan nikmati prosesnya.',
  (t) => 'Dengan pemahaman yang tepat dan langkah yang terarah, ' + t + ' bisa menjadi kebiasaan positif yang memberi dampak dalam jangka panjang.',
];

function generateTitle(topic) {
  return pick1(TITLE_TEMPLATES)(topic);
}

function generateArticle(topic) {
  const intro = pick1(INTRO_TEMPLATES)(topic);
  const points = pickSome(POINT_TEMPLATES, 4).map(p => '- ' + p(topic)).join('\n');
  const bodies = pickSome(BODY_TEMPLATES, 3).map(b => b(topic)).join('\n\n');
  const closing = pick1(CLOSING_TEMPLATES)(topic);
  return [intro, 'Beberapa poin penting yang patut dicatat:\n\n' + points, bodies, closing].join('\n\n');
}

app.post('/api/generate', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const kind = body.kind === 'title' ? 'title' : 'article';
    if (!topic) {
      return res.status(400).json({ error: 'Isi dulu topiknya, misalnya: manfaat membaca buku' });
    }
    const text = kind === 'title' ? generateTitle(topic) : generateArticle(topic);
    res.status(200).json({ text });
  } catch (error) {
    console.error('POST /api/generate gagal:', error);
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