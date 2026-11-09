# Gerenciador de WhatsApp — demo estática (somente leitura)

Protótipo navegável, sem backend: o mock roda no próprio navegador
(`mock-browser.js` intercepta `fetch`/`EventSource`). Hospede em qualquer
host estático (GitHub Pages, Vercel, Netlify, Cloudflare Pages).

## Login de teste
- Admin: `ana@empresa.com` · senha `teste123`
- Visualizador: `bruno@empresa.com` · senha `teste123`

## Deploy rápido
- **Netlify Drop:** arraste esta pasta em https://app.netlify.com/drop
- **Vercel:** `vercel deploy public --prod` (ou importe o repositório)
- **GitHub Pages:** suba estes arquivos na raiz de um repo público e ative Pages (branch, /root)

Arquivos: index.html, styles.css, app.js, admin.js, connect.html, mock-browser.js
