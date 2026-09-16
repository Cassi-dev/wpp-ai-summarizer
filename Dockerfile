# Estágio 1: Imagem Base com Node.js
FROM node:22-slim

# Instala ferramentas necessárias para compilação nativa de pacotes C++ (como better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Diretório de trabalho dentro do container
WORKDIR /app

# Copia arquivos de dependências
COPY package*.json ./
COPY tsconfig.json ./

# Instala todas as dependências
RUN npm install

# Copia o código-fonte
COPY src/ ./src/

# Compila o TypeScript para JavaScript em dist/
RUN npm run build

# Cria os diretórios persistentes para sessão do WhatsApp e banco de dados
RUN mkdir -p /app/auth_info

# Porta padrão de healthcheck para servidores e plataformas na nuvem (Railway, Render, etc.)
EXPOSE 3000
ENV PORT=3000

# Executa o bot compilado em produção
CMD ["npm", "start"]
