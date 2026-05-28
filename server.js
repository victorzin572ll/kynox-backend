// server.js — Backend Kynox Buxx PIX
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
const https   = require('https');
const efi     = require('./efi');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type','x-webhook-secret','Authorization'],
}));
app.options('*', cors());
app.use(express.json());

const pedidos = {};

// ═══════════════════════════════════════════════════════════════
// GET /roblox/search?q=nick — Busca usuários no Roblox
// ═══════════════════════════════════════════════════════════════
app.get('/roblox/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ data: [] });

  try {
    // 1. Buscar IDs pelo nome
    const searchResp = await fetchJson('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      body: JSON.stringify({ usernames: [q], excludeBannedUsers: true }),
    });

    // 2. Buscar sugestões de autocomplete
    const suggestResp = await fetchJson(
      `https://www.roblox.com/search/users/results?keyword=${encodeURIComponent(q)}&maxRows=4&startIndex=0`
    ).catch(() => ({ UserSearchResults: [] }));

    // Juntar resultados únicos
    const ids = new Set();
    const users = [];

    // Do autocomplete
    (suggestResp.UserSearchResults || []).slice(0, 4).forEach(u => {
      if (!ids.has(u.UserId)) {
        ids.add(u.UserId);
        users.push({ id: u.UserId, name: u.Name, displayName: u.DisplayName || u.Name });
      }
    });

    // Da busca exata
    (searchResp.data || []).forEach(u => {
      if (!ids.has(u.id)) {
        ids.add(u.id);
        users.push({ id: u.id, name: u.name, displayName: u.displayName || u.name });
      }
    });

    if (!users.length) return res.json({ data: [] });

    // 3. Buscar avatares em lote
    const idList = users.map(u => u.id).join(',');
    const thumbResp = await fetchJson(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${idList}&size=150x150&format=Png&isCircular=false`
    ).catch(() => ({ data: [] }));

    const avatarMap = {};
    (thumbResp.data || []).forEach(t => { avatarMap[t.targetId] = t.imageUrl; });

    const result = users.map(u => ({
      id:          u.id,
      name:        u.name,
      displayName: u.displayName,
      avatar:      avatarMap[u.id] || null,
    }));

    return res.json({ data: result });

  } catch (err) {
    console.error('[ROBLOX SEARCH]', err.message);
    return res.json({ data: [] });
  }
});

// Helper para fetch com JSON
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'User-Agent':   'Mozilla/5.0',
        ...(opts.headers || {}),
      },
    };
    const req = https.request(options, resp => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// GET /roblox/game-icons?ids=123,456 — thumbnails dos jogos
// ═══════════════════════════════════════════════════════════════
app.get('/roblox/game-icons', async (req, res) => {
  const ids = (req.query.ids || '').trim();
  if (!ids) return res.json({ data: [] });
  try {
    const data = await fetchJson(
      'https://thumbnails.roblox.com/v1/games/icons?universeIds=' + ids + '&size=150x150&format=Png&isCircular=false'
    );
    return res.json(data);
  } catch (err) {
    console.error('[GAME ICONS]', err.message);
    return res.json({ data: [] });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /roblox/gamepasses?universeId=123 — gamepasses de um jogo
// ═══════════════════════════════════════════════════════════════
app.get('/roblox/gamepasses', async (req, res) => {
  const universeId = (req.query.universeId || req.query.placeId || '').trim();
  if (!universeId) return res.json({ data: [] });
  try {
    // Usar catalog API para buscar gamepasses - não precisa de auth
    const catalogResp = await fetchJson(
      'https://catalog.roblox.com/v1/search/items?category=GamePass&universeId=' + universeId + '&limit=100&sortType=0'
    ).catch(() => ({ data: [] }));

    let passes = (catalogResp.data || []).map(item => ({
      id: item.id,
      name: item.name,
      price: item.lowestPrice || item.price || 0,
      imageUrl: null,
    }));

    console.log('[GAMEPASSES] universeId=' + universeId + ' encontradas: ' + passes.length);

    // Se catalog não retornou nada, tenta a API de games diretamente
    if (!passes.length) {
      // Pegar rootPlaceId
      const gameResp = await fetchJson(
        'https://games.roblox.com/v1/games?universeIds=' + universeId
      ).catch(() => ({ data: [] }));
      const placeId = ((gameResp.data||[])[0]||{}).rootPlaceId || universeId;

      const gpResp = await fetchJson(
        'https://games.roblox.com/v1/games/' + placeId + '/game-passes?sortOrder=Asc&limit=100'
      ).catch(() => ({ data: [] }));
      passes = (gpResp.data || []).map(p => ({
        id: p.id, name: p.name, price: p.price || 0, imageUrl: null
      }));
      console.log('[GAMEPASSES] fallback placeId=' + placeId + ' encontradas: ' + passes.length);
    }

    if (passes.length) {
      // Buscar thumbnails
      const gpIds = passes.map(p => p.id).join(',');
      const thumbResp = await fetchJson(
        'https://thumbnails.roblox.com/v1/game-passes?gamePassIds=' + gpIds + '&size=150x150&format=Png'
      ).catch(() => ({ data: [] }));
      const thumbMap = {};
      (thumbResp.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
      passes = passes.map(p => Object.assign({}, p, { imageUrl: thumbMap[p.id] || null }));
    }

    return res.json({ data: passes });
  } catch (err) {
    console.error('[GAMEPASSES] Erro:', err.message);
    return res.json({ data: [] });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /pix/criar
// ═══════════════════════════════════════════════════════════════
app.post('/pix/criar', async (req, res) => {
  try {
    const { orderId, valor, produto, userId, robloxNick } = req.body;
    if (!orderId || !valor || !produto) {
      return res.status(400).json({ erro: 'Campos obrigatórios: orderId, valor, produto' });
    }
    const cob = await efi.criarCobranca({
      valor: parseFloat(valor).toFixed(2),
      orderId,
      desc: `Kynox Buxx - ${produto}`,
    });
    const qr = await efi.gerarQRCode(cob.loc.id);
    pedidos[orderId] = {
      orderId, txid: cob.txid, locId: cob.loc.id, valor, produto,
      userId: userId || 'guest', robloxNick: robloxNick || '',
      status: 'pendente', criadoEm: new Date().toISOString(),
    };
    console.log(`[PIX] Cobrança criada: ${orderId} | R$${valor} | ${produto}`);
    return res.json({
      ok: true, orderId, txid: cob.txid,
      qrcode: qr.qrcode, qrcodeImg: qr.imagemQrcode, expiracao: 3600,
    });
  } catch (err) {
    console.error('[PIX] Erro:', err?.response?.data || err.message);
    return res.status(500).json({ erro: 'Erro ao gerar PIX. Tente novamente.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /pix/status/:orderId
// ═══════════════════════════════════════════════════════════════
app.get('/pix/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const pedido = pedidos[orderId];
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  if (pedido.status === 'pago') return res.json({ status: 'pago', orderId });
  try {
    const cob = await efi.consultarCobranca(pedido.txid);
    if (cob.status === 'CONCLUIDA') {
      pedidos[orderId].status = 'pago';
      pedidos[orderId].pagoEm = new Date().toISOString();
      return res.json({ status: 'pago', orderId });
    }
    return res.json({ status: pedido.status, cobranca: cob.status });
  } catch (err) {
    return res.json({ status: pedido.status });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /pix/webhook
// ═══════════════════════════════════════════════════════════════
app.post('/pix/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const { pix } = req.body;
    if (!pix || !Array.isArray(pix)) return;
    pix.forEach(pagamento => {
      const { txid, valor, horario } = pagamento;
      if (!txid) return;
      const entry = Object.values(pedidos).find(p => p.txid === txid);
      if (!entry || entry.status === 'pago') return;
      entry.status = 'pago';
      entry.pagoEm = horario || new Date().toISOString();
      entry.valorPago = valor;
      console.log(`[WEBHOOK] ✓ Pagamento confirmado: ${entry.orderId} | R$${valor}`);
    });
  } catch (err) {
    console.error('[WEBHOOK] Erro:', err.message);
  }
});

app.get('/pix/webhook', (req, res) => res.sendStatus(200));

app.post('/pix/registrar-webhook', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    const webhookUrl = `${process.env.SITE_URL}/pix/webhook`;
    await efi.registrarWebhook(webhookUrl);
    return res.json({ ok: true, webhookUrl });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/pix/pedidos', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ erro: 'Não autorizado' });
  return res.json(Object.values(pedidos));
});

app.get('/', (req, res) => res.json({ ok: true, servico: 'Kynox Buxx PIX', versao: '2.0.0' }));

app.listen(PORT, () => {
  console.log(`\n🚀 Kynox Buxx Backend rodando na porta ${PORT}`);
  console.log(`   PIX Key: ${process.env.EFI_PIX_KEY}`);
  console.log(`   Modo: ${process.env.EFI_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUÇÃO'}\n`);
});
