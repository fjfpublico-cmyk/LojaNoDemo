const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Guarda o ficheiro em memória (não em disco) — o disco do Railway/Render
// é efémero, por isso enviamos logo para o Cloudinary sem tocar no disco local.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Só são aceites ficheiros de imagem.'));
    }
  }
});

// Ligação à base de dados Postgres.
// DATABASE_URL vem de uma variável de ambiente (Railway injeta-a
// automaticamente quando ligas um plugin Postgres ao projeto).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'chave-temporaria-so-para-desenvolvimento',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 horas
    secure: false // Railway/Render tratam o HTTPS antes do Node ver o pedido
  }
}));

// Middleware que protege rotas de admin — se não tiver sessão válida,
// devolve 401 (para chamadas de API) ou manda para /login (para páginas)
function exigirAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  return res.redirect('/login.html');
}

// Página de admin protegida — TEM de vir antes do express.static,
// senão os ficheiros estáticos servem o admin.html diretamente e
// ignoram por completo a proteção de login.
app.get('/admin.html', exigirAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminHash) {
    console.error('ADMIN_PASSWORD_HASH não está definida nas variáveis de ambiente.');
    return res.status(500).json({ error: 'Configuração de admin em falta no servidor.' });
  }

  if (username !== adminUser) {
    return res.status(401).json({ error: 'Utilizador ou password incorretos.' });
  }

  const senhaCorreta = bcrypt.compareSync(password || '', adminHash);
  if (!senhaCorreta) {
    return res.status(401).json({ error: 'Utilizador ou password incorretos.' });
  }

  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---------------------------------------------------------------------
// Catálogo inicial — só é usado para semear a base de dados na primeira
// vez que o servidor arranca (se a tabela "produtos" estiver vazia).
// Depois disso, o catálogo real vive só na base de dados.
// ---------------------------------------------------------------------
const SEED_PRODUCTS = [
  { id: 'pulseira-tranca',   nome: 'Pulseira Couro Trançado',  categoria: 'Pulseiras', preco: 38.00, material: 'couro',  nota: 'Couro genuíno · fecho em aço escovado' },
  { id: 'pulseira-cordao',   nome: 'Pulseira Cordão Duplo',     categoria: 'Pulseiras', preco: 24.00, material: 'cordao', nota: 'Cordão encerado · ajustável' },
  { id: 'pulseira-no',       nome: 'Pulseira Nó Marinheiro',    categoria: 'Pulseiras', preco: 29.00, material: 'cordao', nota: 'Nó feito à mão · algodão trançado' },
  { id: 'anel-aro',          nome: 'Anel Aro Fino',             categoria: 'Anéis',     preco: 32.00, material: 'metal',  nota: 'Aço inoxidável · acabamento mate' },
  { id: 'anel-assimetrico',  nome: 'Anel Assimétrico',          categoria: 'Anéis',     preco: 45.00, material: 'metal',  nota: 'Latão banhado · peça única' },
  { id: 'anel-camadas',      nome: 'Anel Duplo Camada',         categoria: 'Anéis',     preco: 39.00, material: 'metal',  nota: 'Aço inoxidável · duas camadas sobrepostas' },
  { id: 'brincos-argola',    nome: 'Brincos Argola Mínima',     categoria: 'Brincos',   preco: 27.00, material: 'metal',  nota: 'Par · aço hipoalergénico' },
  { id: 'brincos-barra',     nome: 'Brincos Barra Reta',        categoria: 'Brincos',   preco: 25.00, material: 'metal',  nota: 'Par · linha reta minimalista' },
  { id: 'colar-cera',        nome: 'Colar Cordão de Cera',      categoria: 'Colares',   preco: 34.00, material: 'cordao', nota: 'Cordão de cera · fecho ajustável' },
  { id: 'colar-placa',       nome: 'Colar Placa Gravável',      categoria: 'Colares',   preco: 48.00, material: 'metal',  nota: 'Aço escovado · espaço para gravação' },
];

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      categoria TEXT NOT NULL,
      preco NUMERIC(10,2) NOT NULL,
      material TEXT,
      nota TEXT
    );
  `);

  // Adiciona a coluna de imagem se ainda não existir — seguro correr
  // isto sempre que o servidor arranca, mesmo em bases já existentes.
  await pool.query(`
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS imagem_url TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      itens JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      cliente JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente_pagamento',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*) FROM produtos');
  if (parseInt(rows[0].count, 10) === 0) {
    for (const p of SEED_PRODUCTS) {
      await pool.query(
        'INSERT INTO produtos (id, nome, categoria, preco, material, nota) VALUES ($1,$2,$3,$4,$5,$6)',
        [p.id, p.nome, p.categoria, p.preco, p.material, p.nota]
      );
    }
    console.log(`Seed: ${SEED_PRODUCTS.length} produtos inseridos na base de dados.`);
  } else {
    console.log(`Base de dados já tem ${rows[0].count} produtos — seed ignorado.`);
  }
}

// Catálogo público — agora vem da base de dados
app.get('/api/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome, categoria, preco::float AS preco, material, nota, imagem_url FROM produtos ORDER BY categoria, nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao carregar produtos:', err);
    res.status(500).json({ error: 'Erro ao carregar produtos.' });
  }
});

// Gera um id legível a partir do nome (ex: "Anel Duplo" -> "anel-duplo")
function slugify(texto) {
  return texto
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ---------------------------------------------------------------------
// Rotas de admin — todas protegidas por exigirAdmin. Só um utilizador
// autenticado (o login que já testámos) consegue criar, editar ou
// apagar produtos. A rota pública GET /api/produtos continua aberta,
// como sempre, para qualquer cliente ver o catálogo.
// ---------------------------------------------------------------------

// Upload de imagem — recebe o ficheiro do formulário, envia para o
// Cloudinary, e devolve o URL final para guardar no produto.
app.post('/api/admin/upload-imagem', exigirAdmin, upload.single('imagem'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum ficheiro recebido.' });
  }
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: 'Cloudinary não está configurado no servidor.' });
  }

  try {
    const resultado = await new Promise((resolve, reject) => {
      const streamUpload = cloudinary.uploader.upload_stream(
        { folder: 'no-studio-produtos' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      streamUpload.end(req.file.buffer);
    });

    res.json({ success: true, url: resultado.secure_url });
  } catch (err) {
    console.error('Erro ao enviar imagem para o Cloudinary:', err);
    res.status(500).json({ error: 'Erro ao enviar imagem.' });
  }
});

// Criar novo produto
app.post('/api/admin/produtos', exigirAdmin, async (req, res) => {
  const { nome, categoria, preco, material, nota, imagem_url } = req.body;

  if (!nome || !categoria || preco === undefined || preco === null) {
    return res.status(400).json({ error: 'Nome, categoria e preço são obrigatórios.' });
  }
  const precoNum = parseFloat(preco);
  if (isNaN(precoNum) || precoNum <= 0) {
    return res.status(400).json({ error: 'Preço inválido.' });
  }

  try {
    let id = slugify(nome);
    if (!id) {
      return res.status(400).json({ error: 'Nome inválido para gerar identificador.' });
    }

    // Garante que o id é único — se já existir, acrescenta -2, -3, etc.
    let idFinal = id;
    let sufixo = 2;
    while (true) {
      const { rows } = await pool.query('SELECT 1 FROM produtos WHERE id = $1', [idFinal]);
      if (rows.length === 0) break;
      idFinal = `${id}-${sufixo}`;
      sufixo++;
    }

    await pool.query(
      'INSERT INTO produtos (id, nome, categoria, preco, material, nota, imagem_url) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [idFinal, nome, categoria, precoNum, material || null, nota || null, imagem_url || null]
    );

    res.json({ success: true, id: idFinal });
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    res.status(500).json({ error: 'Erro ao criar produto.' });
  }
});

// Editar produto existente
app.put('/api/admin/produtos/:id', exigirAdmin, async (req, res) => {
  const { id } = req.params;
  const { nome, categoria, preco, material, nota, imagem_url } = req.body;

  if (!nome || !categoria || preco === undefined || preco === null) {
    return res.status(400).json({ error: 'Nome, categoria e preço são obrigatórios.' });
  }
  const precoNum = parseFloat(preco);
  if (isNaN(precoNum) || precoNum <= 0) {
    return res.status(400).json({ error: 'Preço inválido.' });
  }

  try {
    const resultado = await pool.query(
      'UPDATE produtos SET nome=$1, categoria=$2, preco=$3, material=$4, nota=$5, imagem_url=$6 WHERE id=$7',
      [nome, categoria, precoNum, material || null, nota || null, imagem_url || null, id]
    );
    if (resultado.rowCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao editar produto:', err);
    res.status(500).json({ error: 'Erro ao editar produto.' });
  }
});

// Apagar produto
app.delete('/api/admin/produtos/:id', exigirAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const resultado = await pool.query('DELETE FROM produtos WHERE id=$1', [id]);
    if (resultado.rowCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao apagar produto:', err);
    res.status(500).json({ error: 'Erro ao apagar produto.' });
  }
});

// Criar pedido — preço sempre recalculado a partir da base de dados
app.post('/api/pedidos', async (req, res) => {
  const { items, cliente } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Carrinho vazio.' });
  }
  if (!cliente || !cliente.nome || !cliente.email) {
    return res.status(400).json({ error: 'Dados do cliente incompletos.' });
  }

  try {
    const { rows: produtosDb } = await pool.query(
      'SELECT id, nome, preco::float AS preco FROM produtos'
    );

    let total = 0;
    const linhasPedido = [];

    for (const item of items) {
      const produto = produtosDb.find(p => p.id === item.productId);
      if (!produto) {
        return res.status(400).json({ error: `Produto inválido: ${item.productId}` });
      }
      const qty = Math.max(1, parseInt(item.qty, 10) || 1);
      const subtotal = Math.round(produto.preco * qty * 100) / 100;
      total += subtotal;

      linhasPedido.push({
        productId: produto.id,
        nome: produto.nome,
        precoUnitario: produto.preco,
        qty,
        subtotal
      });
    }
    total = Math.round(total * 100) / 100;

    const id = 'pedido_' + Date.now();
    await pool.query(
      'INSERT INTO pedidos (id, itens, total, cliente, status) VALUES ($1,$2,$3,$4,$5)',
      [id, JSON.stringify(linhasPedido), total, JSON.stringify(cliente), 'pendente_pagamento']
    );

    console.log(`Novo pedido: ${id} — ${linhasPedido.length} item(ns) — total ${total}€`);

    res.json({ success: true, pedidoId: id, total, checkoutUrl: null });
  } catch (err) {
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido.' });
  }
});

app.get('/api/pedidos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos ORDER BY criado_em DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar pedidos.' });
  }
});

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Loja a correr em http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Erro ao preparar a base de dados:', err);
    process.exit(1);
  });
