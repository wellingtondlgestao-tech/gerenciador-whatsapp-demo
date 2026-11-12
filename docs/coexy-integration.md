# Integração com o Coexy (API oficial WhatsApp via coexistência)

O Coexy é um **relay da WhatsApp Cloud API** da Meta. O webhook chega no **formato nativo da Meta**,
assinado com `X-Coexy-Signature: sha256=<hex>` (HMAC-SHA256 do corpo bruto). A mídia é baixada pelo
**meta-proxy do Coexy** usando o `channel_token`, não pela Graph API da Meta.

Este backend (`server/whatsapp-backend.js`) já implementa tudo isso.

## Variáveis de ambiente (no Render)

| Variável | O que é | Onde pegar no Coexy |
| --- | --- | --- |
| `COEXY_HMAC_SECRET` | segredo p/ validar a assinatura do webhook | retornado ao **criar o webhook** (salve na hora) |
| `WA_NUMBERS` | JSON dos números (inclui `phone_number_id` e `channel_token`) | Canais → detalhe do canal → aba API |
| `LOGIN_EMAIL` / `LOGIN_PASSWORD` | login do painel | você escolhe |

Exemplo de `WA_NUMBERS` (um número):
```json
[{"id":"n1","name":"Meu WhatsApp","phone":"+55 62 99966-5277","phone_number_id":"<PHONE_NUMBER_ID>","type":"comercial","channel_token":"<CHANNEL_TOKEN>"}]
```
> `channel_token` é segredo — fica só em variável de ambiente do servidor, nunca no frontend/git.

## Passos para ligar (ordem)

1. **Deploy no Render** (`render.yaml` já configurado). Anote a URL pública, ex.: `https://SEU-APP.onrender.com`.
2. **Coexy → Canais → criar canal** → abra o `connect_url` e conecte o número no WhatsApp Business.
   Depois copie o `phone_number_id` e o `channel_token` (aba API do canal).
3. **Coexy → Webhooks → criar webhook**:
   - URL: `https://SEU-APP.onrender.com/webhook`
   - Eventos: `messages`, `smb_message_echoes`, `channel_status_update`
   - Salve o `hmac_secret` → vira `COEXY_HMAC_SECRET` no Render.
4. **Render → Environment**: preencha `COEXY_HMAC_SECRET`, `WA_NUMBERS` (com phone_number_id + channel_token),
   `LOGIN_EMAIL`, `LOGIN_PASSWORD`. Redeploy.
5. Envie/receba uma mensagem no número → aparece no painel em tempo real (com mídia).

## O que o backend faz
- `GET /webhook` → verificação (não usada pelo Coexy, mas mantida p/ Meta direto).
- `POST /webhook` → valida `X-Coexy-Signature` (HMAC-SHA256), responde 200 na hora, processa depois;
  deduplica por `wamid`; grava recebidas (`messages`) e enviadas pelo app (`smb_message_echoes` → coexistência).
- `GET /api/media/:numberId/:id` → baixa a mídia pelo meta-proxy do Coexy com o `channel_token` do número
  (ou pela Graph da Meta se o número tiver `WHATSAPP_TOKEN` em vez de `channel_token`).
- Serve o painel (somente leitura) + API + SSE.

Spec completo do Coexy: clique em **"Copiar spec" / "Documentação"** no painel do Coexy.
