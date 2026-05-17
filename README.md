# Kynox Buxx — Backend PIX (Efí Bank)

## Arquivos
```
kynox-backend/
├── server.js          ← Servidor principal
├── efi.js             ← Integração com API Efí
├── package.json
├── vercel.json        ← Config para deploy Vercel
├── .env               ← Suas credenciais (NÃO envie para o Git)
├── .env.example       ← Modelo do .env
├── .gitignore
└── certs/
    └── producao-873607-kynox.p12  ← Certificado Efí
```

---

## Como subir o backend

### Opção 1: Railway (mais fácil, grátis)
1. Acesse https://railway.app e crie conta
2. Clique em **New Project → Deploy from GitHub**
3. Suba esta pasta no GitHub primeiro (sem o .env)
4. No Railway, vá em **Variables** e adicione:
   - `EFI_CLIENT_ID` = Client_Id_e4dfca2...
   - `EFI_CLIENT_SECRET` = Client_Secret_498...
   - `EFI_PIX_KEY` = 71f80ac7-2bd3-...
   - `EFI_SANDBOX` = false
   - `WEBHOOK_SECRET` = kynox_webhook_2025
   - `SITE_URL` = https://sua-url.railway.app
5. Copie a URL gerada (ex: `https://kynox-backend.up.railway.app`)

### Opção 2: Vercel
1. Instale Vercel CLI: `npm i -g vercel`
2. Na pasta do backend: `vercel login` → `vercel`
3. Adicione as variáveis de ambiente no painel da Vercel
4. Copie a URL gerada

---

## Após subir o backend

### 1. Atualizar a URL no site
No arquivo `js/main.js`, linha com `BACKEND_URL`:
```js
const BACKEND_URL = 'https://SUA-URL-DO-BACKEND.railway.app';
```

### 2. Registrar o webhook na Efí (UMA VEZ)
```bash
curl -X POST https://SUA-URL/pix/registrar-webhook \
  -H "x-webhook-secret: kynox_webhook_2025"
```

---

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | /pix/criar | Criar cobrança PIX |
| GET | /pix/status/:orderId | Verificar se foi pago |
| POST | /pix/webhook | Receber notificação Efí |
| GET | /pix/webhook | Validação Efí |
| POST | /pix/registrar-webhook | Registrar webhook (1x) |
| GET | /pix/pedidos | Listar pedidos (protegido) |

---

## Fluxo de pagamento

```
Cliente clica "Pagar com Pix"
    ↓
Frontend chama POST /pix/criar
    ↓
Backend cria cobrança na Efí → retorna QR Code
    ↓
Cliente escaneia QR Code no banco
    ↓
Efí chama POST /pix/webhook → backend marca como "pago"
    ↓
Frontend faz polling GET /pix/status → detecta pagamento
    ↓
Pedido confirmado automaticamente ✓
```

---

## Senha do painel ADM
`Kynox@2025#Adm`
(arquivo: painel.html)
