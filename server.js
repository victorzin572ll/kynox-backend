// server.js — Backend Kynox Buxx PIX
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
const efi     = require('./efi');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS — permite qualquer origem ──────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type','x-webhook-secret','Authorization'],
}));
app.options('*', cors());
app.use(express.json());

// ── Pedidos em memória (em produção use um banco de dados) ───────
// Estrutura: { [orderId]: { status, txid, locId, valor, produto, userId, ... } }
const pedidos = {};

// ═══════════════════════════════════════════════════════════════
// POST /pix/criar — Front chama isso para criar cobrança
// Body: { orderId, valor, produto, userId, robloxNick }
// ═══════════════════════════════════════════════════════════════
app.post('/pix/criar', async (req, res) => {
  try {
    const { orderId, valor, produto, userId, robloxNick } = req.body;

    if (!orderId || !valor || !produto) {
      return res.status(400).json({ erro: 'Campos obrigatórios: orderId, valor, produto' });
    }

    // Criar cobrança na Efí
    const cob = await efi.criarCobranca({
      valor: parseFloat(valor).toFixed(2),
      orderId,
      desc: `Kynox Buxx - ${produto}`,
    });

    // Gerar QR Code
    const qr = await efi.gerarQRCode(cob.loc.id);

    // Salvar pedido
    pedidos[orderId] = {
      orderId,
      txid:      cob.txid,
      locId:     cob.loc.id,
      valor,
      produto,
      userId:    userId  || 'guest',
      robloxNick: robloxNick || '',
      status:    'pendente', // pendente | pago | expirado
      criadoEm:  new Date().toISOString(),
    };

    console.log(`[PIX] Cobrança criada: ${orderId} | R$${valor} | ${produto}`);

    return res.json({
      ok: true,
      orderId,
      txid:      cob.txid,
      qrcode:    qr.qrcode,         // código copia-e-cola
      qrcodeImg: qr.imagemQrcode,   // imagem base64 do QR
      expiracao: 3600,
    });

  } catch (err) {
    console.error('[PIX] Erro ao criar cobrança:', err?.response?.data || err.message);
    return res.status(500).json({ erro: 'Erro ao gerar PIX. Tente novamente.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /pix/status/:orderId — Front consulta se foi pago
// ═══════════════════════════════════════════════════════════════
app.get('/pix/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const pedido = pedidos[orderId];

  if (!pedido) {
    return res.status(404).json({ erro: 'Pedido não encontrado' });
  }

  // Se já marcado como pago localmente
  if (pedido.status === 'pago') {
    return res.json({ status: 'pago', orderId });
  }

  // Consultar diretamente na Efí
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
// POST /pix/webhook — Efí chama quando pagamento é confirmado
// ═══════════════════════════════════════════════════════════════
app.post('/pix/webhook', (req, res) => {
  // Efí exige resposta 200 imediata
  res.sendStatus(200);

  try {
    const { pix } = req.body;
    if (!pix || !Array.isArray(pix)) return;

    pix.forEach(pagamento => {
      const { txid, valor, horario } = pagamento;
      if (!txid) return;

      // Achar pedido pelo txid
      const entry = Object.values(pedidos).find(p => p.txid === txid);
      if (!entry) {
        console.log(`[WEBHOOK] txid não encontrado localmente: ${txid}`);
        return;
      }

      if (entry.status === 'pago') return; // já processado

      entry.status = 'pago';
      entry.pagoEm = horario || new Date().toISOString();
      entry.valorPago = valor;

      console.log(`[WEBHOOK] ✓ Pagamento confirmado: ${entry.orderId} | R$${valor}`);

      // Aqui você pode:
      // - Enviar notificação Discord
      // - Atualizar banco de dados
      // - Enviar email ao cliente
    });
  } catch (err) {
    console.error('[WEBHOOK] Erro:', err.message);
  }
});

// ── GET /pix/webhook (Efí valida o endpoint com GET) ────────────
app.get('/pix/webhook', (req, res) => res.sendStatus(200));

// ═══════════════════════════════════════════════════════════════
// POST /pix/registrar-webhook — Registra URL do webhook na Efí
// Chame UMA VEZ após subir o servidor
// ═══════════════════════════════════════════════════════════════
app.post('/pix/registrar-webhook', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  try {
    const webhookUrl = `${process.env.SITE_URL}/pix/webhook`;
    await efi.registrarWebhook(webhookUrl);
    return res.json({ ok: true, webhookUrl });
  } catch (err) {
    console.error('[WEBHOOK] Erro ao registrar:', err?.response?.data || err.message);
    return res.status(500).json({ erro: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /pix/pedidos — Ver todos os pedidos (protegido)
// ═══════════════════════════════════════════════════════════════
app.get('/pix/pedidos', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  return res.json(Object.values(pedidos));
});

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, servico: 'Kynox Buxx PIX', versao: '1.0.0' }));

// ── Iniciar servidor ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Kynox Buxx Backend rodando na porta ${PORT}`);
  console.log(`   PIX Key: ${process.env.EFI_PIX_KEY}`);
  console.log(`   Modo: ${process.env.EFI_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUÇÃO'}\n`);
});