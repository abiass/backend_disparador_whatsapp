# Backend - Disparador WhatsApp

Este é o servidor backend do sistema Disparador WhatsApp, construído com Node.js e Express.

## 📁 Estrutura

```
backend/
├── server.js              # Servidor principal
├── package.json           # Dependências do backend
├── .env.example           # Template de variáveis de ambiente
├── .env                   # Variáveis de ambiente (não commitar)
├── config/
│   └── database.js        # Configuração do banco de dados
├── routes/
│   ├── loginRoutes.js     # Rotas de autenticação
│   ├── usuariosRoutes.js  # Rotas de usuários
│   ├── campanhasRoutes.js # Rotas de campanhas
│   ├── contatosRoutes.js  # Rotas de contatos
│   └── templatesRelatoriosRoutes.js # Rotas de templates e relatórios
├── middleware/
│   └── authMiddleware.js  # Middleware de autenticação JWT
├── classes/
│   └── FilaDisparo.js     # Classe para gerenciar fila de disparo
└── utils/
    └── importacao.js      # Utilitários para importação
```

## 🚀 Desenvolvimento Local

### Pré-requisitos
- Node.js 18+ 
- PostgreSQL (ou Supabase)
- Conta WhatsApp para testes

### Instalação

1. Entre na pasta do backend:
```bash
cd backend
```

2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente:
```bash
cp .env.example .env
# Edite o arquivo .env com suas credenciais
```

4. Inicie o servidor:
```bash
# Desenvolvimento (com watch mode)
npm run dev

# Produção
npm start
```

O servidor estará rodando em `http://localhost:3001`

## 🔧 Variáveis de Ambiente

Veja o arquivo `.env.example` para a lista completa de variáveis necessárias.

### Principais variáveis:

- `DB_*`: Credenciais do banco de dados (Supabase)
- `PORT`: Porta do servidor (padrão: 3001)
- `JWT_SECRET`: Chave secreta para tokens JWT
- `FRONTEND_URL`: URL do frontend (para CORS)

### Persistência de Sessão WhatsApp (opcional - gratuito)
Se pretende usar o Render Free e manter a sessão do WhatsApp entre reinicializações, configure as seguintes variáveis no backend:

- `SUPABASE_URL` - URL do projeto Supabase (ex: `https://xyz.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY` - Service Role Key (MANTER EM SEGREDO)
- `SUPABASE_SESSION_BUCKET` - nome do bucket (ex: `wpp-sessions`)
- `SESSION_FILE_KEY` - nome do arquivo zip de sessão (ex: `session-default.zip`)
- `SESSION_UPLOAD_INTERVAL_MINUTES` - intervalo em minutos para upload periódico (default: 5)

O backend já inclui `backend/utils/sessionStore.js` que faz download antes da inicialização e upload periódico/ao encerrar.

## 📡 Endpoints da API

### Autenticação
- `POST /api/login` - Login de usuário

### Usuários
- `GET /api/usuarios` - Listar usuários
- `POST /api/usuarios` - Criar usuário
- `PUT /api/usuarios/:id` - Atualizar usuário
- `DELETE /api/usuarios/:id` - Deletar usuário

### Campanhas
- `GET /api/campanhas` - Listar campanhas
- `GET /api/campanhas/:id` - Detalhes da campanha
- `POST /api/campanhas` - Criar campanha
- `POST /api/campanhas/:id/iniciar` - Iniciar campanha
- `POST /api/campanhas/:id/pausar` - Pausar campanha
- `DELETE /api/campanhas/:id` - Deletar campanha

### Contatos
- `GET /api/contatos` - Listar contatos
- `POST /api/contatos/importar` - Importar contatos (CSV/Excel)
- `DELETE /api/contatos/:id` - Deletar contato
- `GET /api/contatos/exportar/csv` - Exportar contatos
- `GET /api/contatos/template/download` - Download template

### WhatsApp
- `GET /api/whatsapp/qr` - Obter QR code para conexão
- `POST /api/whatsapp/send` - Enviar mensagem
- `GET /api/whatsapp/chat/:numero` - Histórico de conversa

### Leads
- `GET /api/leads` - Listar leads
- `POST /api/leads/cadastrar` - Cadastrar lead
- `PUT /api/leads/:id/status` - Atualizar status do lead
- `GET /api/leads/relatorio` - Relatório de leads
- `GET /api/leads/relatorio/csv` - Exportar CSV

### WebSocket
- Endpoint: `ws://localhost:3001` (ou sua URL de produção)
- Eventos: 
  - `new_message` - Nova mensagem recebida
  - `lead_update` - Lead atualizado

## 🐛 Debug

Para ver logs detalhados:
```bash
DEBUG=true npm run dev
```

## 🔒 Segurança

- JWT para autenticação
- Senhas hash com bcrypt
- CORS configurado
- Validação de inputs
- SSL no banco de dados (produção)

## 📦 Deploy

Veja o arquivo [DEPLOY.md](../DEPLOY.md) na raiz do projeto para instruções completas de deploy no Render.

### Quick Start (Render)
1. Faça push do código para GitHub
2. Conecte o repositório no Render
3. Configure `Root Directory` como `backend`
4. Adicione as variáveis de ambiente
5. Deploy!

## 🛠️ Tecnologias

- **Express** - Framework web
- **PostgreSQL** (via pg) - Banco de dados
- **whatsapp-web.js** - API do WhatsApp
- **JWT** - Autenticação
- **WebSocket (ws)** - Comunicação em tempo real
- **Multer** - Upload de arquivos
- **XLSX** - Processamento de planilhas

## 📝 Licença

[Sua licença aqui]
