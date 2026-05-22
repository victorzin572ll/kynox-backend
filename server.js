require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-webhook-secret,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Persistência ─────────────────────────────────────────────────
const PEDIDOS_FILE = '/tmp/pedidos.json';
function loadPedidos(){ try{ return JSON.parse(fs.readFileSync(PEDIDOS_FILE,'utf8')); }catch(e){ return {}; } }
function savePedidos(p){ try{ fs.writeFileSync(PEDIDOS_FILE,JSON.stringify(p)); }catch(e){} }
let pedidos = loadPedidos();

// ── Efí ──────────────────────────────────────────────────────────
const BASE_URL = 'https://pix.api.efipay.com.br';
let _token = null, _tokenExp = 0;

function getAgent(){
  const d = process.env.EFI_CERT_BASE64
    ? Buffer.from(process.env.EFI_CERT_BASE64,'base64')
    : fs.readFileSync(path.resolve('./certs/producao-873607-kynox.p12'));
  return new https.Agent({ pfx:d, passphrase:'', rejectUnauthorized:false });
}
async function getToken(){
  if(_token && Date.now()<_tokenExp) return _token;
  const creds = Buffer.from(`${process.env.EFI_CLIENT_ID}:${process.env.EFI_CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(`${BASE_URL}/oauth/token`,{grant_type:'client_credentials'},{
    httpsAgent:getAgent(), headers:{Authorization:`Basic ${creds}`,'Content-Type':'application/json'}
  });
  _token=r.data.access_token; _tokenExp=Date.now()+(r.data.expires_in-60)*1000;
  return _token;
}
async function efiApi(){
  const t=await getToken();
  return axios.create({baseURL:BASE_URL,httpsAgent:getAgent(),headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json'}});
}

// txid válido: 26-35 chars alfanuméricos
function gerarTxid(){
  const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r=''; for(let i=0;i<35;i++) r+=c[Math.floor(Math.random()*c.length)];
  return r;
}

// ── Health ───────────────────────────────────────────────────────
app.get('/', (req,res) => res.json({ok:true,servico:'Kynox Buxx PIX',versao:'7.0.0'}));

// ── Proxy Roblox (evita CORS) ────────────────────────────────────
app.get('/roblox/search', async (req,res) => {
  try{
    const { q } = req.query;
    if(!q||q.length<2) return res.json({data:[]});

    const [r1,r2] = await Promise.allSettled([
      axios.post('https://users.roblox.com/v1/usernames/users',
        {usernames:[q],excludeBannedUsers:true},
        {headers:{'Content-Type':'application/json'},timeout:6000}
      ),
      axios.get(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(q)}&limit=8`,
        {timeout:6000}
      )
    ]);

    const exact = r1.status==='fulfilled' ? (r1.value.data?.data||[]).map(u=>({id:u.id,name:u.name,displayName:u.displayName||u.name})) : [];
    const sugs  = r2.status==='fulfilled' ? (r2.value.data?.data||[]).slice(0,5).map(u=>({id:u.id,name:u.name,displayName:u.displayName||u.name})) : [];

    const seen=new Set();
    const users=[...exact,...sugs].filter(u=>{ if(seen.has(u.id)) return false; seen.add(u.id); return true; }).slice(0,5);

    if(users.length){
      const ids=users.map(u=>u.id).join(',');
      try{
        const ra=await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids}&size=48x48&format=Png`,{timeout:4000});
        (ra.data?.data||[]).forEach(item=>{
          const u=users.find(x=>x.id===item.targetId);
          if(u) u.avatar=item.imageUrl||null;
        });
      }catch(e){}
    }
    return res.json({data:users});
  }catch(err){
    console.error('[ROBLOX]',err.message);
    return res.json({data:[]});
  }
});

// ── POST /pix/criar ──────────────────────────────────────────────
app.post('/pix/criar', async (req,res) => {
  try{
    const {orderId,valor,produto,userId,robloxNick}=req.body;
    if(!orderId||!valor||!produto) return res.status(400).json({erro:'orderId, valor e produto obrigatorios'});

    const txid  = gerarTxid();
    const client= await efiApi();

    const cob = await client.put(`/v2/cob/${txid}`,{
      calendario:{expiracao:3600},
      valor:{original:parseFloat(valor).toFixed(2)},
      chave:process.env.EFI_PIX_KEY,
      solicitacaoPagador:`Kynox Buxx - ${produto}`,
    });
    const qr = await client.get(`/v2/loc/${cob.data.loc.id}/qrcode`);

    pedidos[orderId]={orderId,txid,valor,produto,userId:userId||'guest',robloxNick:robloxNick||'',status:'pendente',criadoEm:new Date().toISOString()};
    savePedidos(pedidos);

    console.log(`[PIX] Criado: ${orderId} | R$${valor}`);
    return res.json({ok:true,orderId,txid,qrcode:qr.data.qrcode,qrcodeImg:qr.data.imagemQrcode,expiracao:3600});
  }catch(err){
    console.error('[PIX] Erro:',JSON.stringify(err?.response?.data)||err.message);
    return res.status(500).json({erro:'Erro ao gerar PIX.'});
  }
});

// ── GET /pix/status/:orderId ─────────────────────────────────────
app.get('/pix/status/:orderId', async (req,res) => {
  pedidos=loadPedidos();
  const p=pedidos[req.params.orderId];
  if(!p) return res.status(404).json({erro:'Pedido nao encontrado'});
  if(p.status==='pago') return res.json({status:'pago',orderId:req.params.orderId});
  try{
    const c=await efiApi();
    const cob=await c.get(`/v2/cob/${p.txid}`);
    if(cob.data.status==='CONCLUIDA'){
      pedidos[req.params.orderId].status='pago';
      pedidos[req.params.orderId].pagoEm=new Date().toISOString();
      savePedidos(pedidos);
      return res.json({status:'pago',orderId:req.params.orderId});
    }
    return res.json({status:p.status,cobranca:cob.data.status});
  }catch(err){ return res.json({status:p.status}); }
});

// ── POST /pix/webhook ────────────────────────────────────────────
app.post('/pix/webhook',(req,res)=>{
  res.sendStatus(200);
  try{
    pedidos=loadPedidos();
    const {pix}=req.body;
    if(!pix||!Array.isArray(pix)) return;
    let changed=false;
    pix.forEach(p=>{
      if(!p.txid) return;
      const e=Object.values(pedidos).find(x=>x.txid===p.txid);
      if(!e||e.status==='pago') return;
      e.status='pago'; e.pagoEm=p.horario||new Date().toISOString(); e.valorPago=p.valor;
      changed=true;
      console.log(`[WEBHOOK] Pago: ${e.orderId} | R$${p.valor}`);
    });
    if(changed) savePedidos(pedidos);
  }catch(err){ console.error('[WEBHOOK]',err.message); }
});

app.get('/pix/webhook',(req,res)=>res.sendStatus(200));

// ── POST /pix/registrar-webhook ──────────────────────────────────
app.post('/pix/registrar-webhook', async (req,res)=>{
  if(req.headers['x-webhook-secret']!==process.env.WEBHOOK_SECRET) return res.status(401).json({erro:'Nao autorizado'});
  try{
    const c=await efiApi();
    const url=`https://kynox-backend-production.up.railway.app/pix/webhook`;
    await c.put(`/v2/webhook/${process.env.EFI_PIX_KEY}`,{webhookUrl:url});
    console.log('[WEBHOOK] Registrado:',url);
    return res.json({ok:true,webhookUrl:url});
  }catch(err){ return res.status(500).json({erro:err.message}); }
});

// ── GET /pix/pedidos ─────────────────────────────────────────────
app.get('/pix/pedidos',(req,res)=>{
  if(req.headers['x-webhook-secret']!==process.env.WEBHOOK_SECRET) return res.status(401).json({erro:'Nao autorizado'});
  return res.json(Object.values(loadPedidos()));
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, async ()=>{
  console.log(`Kynox Buxx PIX v7.0.0 | porta ${PORT} | PRODUCAO`);
  try{
    const c=await efiApi();
    await c.put(`/v2/webhook/${process.env.EFI_PIX_KEY}`,{webhookUrl:'https://kynox-backend-production.up.railway.app/pix/webhook'});
    console.log('[WEBHOOK] Auto-registrado OK');
  }catch(e){ console.log('[WEBHOOK] Aviso:',e?.response?.data?.mensagem||e.message); }
});
