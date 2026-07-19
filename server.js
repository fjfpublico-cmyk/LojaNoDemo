const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'pedidos.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Catálogo — fonte única da verdade para preços.
// O frontend NUNCA envia o preço; envia só o productId e a quantidade.
// O servidor é quem decide quanto custa, sempre.
// ---------------------------------------------------------------------
const PRODUCTS = [
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

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
  }
}

function lerPedidos() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function guardarPedidos(lista) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(lista, null, 2));
}

// Catálogo público — o frontend busca aqui em vez de ter preços fixos no HTML
app.get('/api/produtos', (req, res) => {
  res.json(PRODUCTS);
});

// Criar pedido a partir do carrinho
// Body esperado: { items: [{ productId, qty }], cliente: { nome, email, telefone } }
app.post('/api/pedidos', (req, res) => {
  const { items, cliente } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Carrinho vazio.' });
  }
  if (!cliente || !cliente.nome || !cliente.email) {
    return res.status(400).json({ error: 'Dados do cliente incompletos.' });
  }

  // Recalcula tudo a partir do catálogo do servidor — ignora qualquer preço
  // que porventura viesse do frontend.
  let total = 0;
  const linhasPedido = [];

  for (const item of items) {
    const produto = PRODUCTS.find(p => p.id === item.productId);
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

  const pedidos = lerPedidos();
  const novoPedido = {
    id: 'pedido_' + Date.now(),
    itens: linhasPedido,
    total,
    cliente,
    status: 'pendente_pagamento', // passa a "pago" quando o webhook do Stripe confirmar
    criadoEm: new Date().toISOString()
  };

  pedidos.push(novoPedido);
  guardarPedidos(pedidos);

  console.log(`Novo pedido: ${novoPedido.id} — ${linhasPedido.length} item(ns) — total ${total}€`);

  // Próxima etapa: aqui criamos a sessão Stripe Checkout com estas linhas
  // (cartão + MB Way) e devolvemos checkoutUrl para redirecionar o cliente.
  res.json({
    success: true,
    pedidoId: novoPedido.id,
    total: novoPedido.total,
    checkoutUrl: null
  });
});

app.get('/api/pedidos', (req, res) => {
  res.json(lerPedidos());
});

app.listen(PORT, () => {
  console.log(`Loja a correr em http://localhost:${PORT}`);
});
