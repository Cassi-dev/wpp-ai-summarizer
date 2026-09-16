<div align="center">

# 🤖 WhatsApp AI Summarizer

**Monitoramento inteligente de grupos e conversas do WhatsApp com resumos estruturados, transcrição de áudios e respostas a dúvidas via Google Gemini AI.**

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Gemini%20AI-8E75C2?style=for-the-badge&logo=google&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

</div>

---

## 📌 Visão Geral do Projeto

Em grupos movimentados de trabalho, estudos ou condomínio, dezenas de mensagens e áudios chegam a cada hora. O **WhatsApp AI Summarizer** resolve essa sobrecarga de informação conectando diretamente ao WhatsApp e gerando **resumos executivos imediatos**, **transcrição de áudios sem precisar ouvi-los** e **respostas para perguntas pontuais sobre o histórico da conversa** via API do Google Gemini.

O diferencial deste projeto não é apenas "gerar texto livre", mas utilizar **Structured Output (JSON Schema)** e capacidades **Multimodais nativas de áudio** para organizar a comunicação em tempo real.

---

## 🏗️ Arquitetura do Sistema

```mermaid
graph TD
    User[WhatsApp / Celular] -->|1. Mensagens de texto| Buffer[Ring Buffer em Memória]
    User -->|2. Áudio recebido| Media[Download de Áudio Baileys]
    
    User -->|!resumo| Buffer
    Buffer -->|Últimas N mensagens| GeminiText[Gemini 3.6 Flash: Structured Output]
    GeminiText -->|JSON com tópicos, decisões e urgência| Format1[Formatador de Markdown]
    Format1 -->|Envia no chat| User
    
    User -->|!pergunta sobre o chat| Buffer
    Buffer -->|Contexto recente + Dúvida| GeminiQA[Gemini 3.6 Flash: Q&A Contextual]
    GeminiQA -->|Resposta pontual| User

    User -->|!ouvir respondendo a um áudio| Media
    Media -->|Buffer OGG/Opus Base64| GeminiAudio[Gemini 3.6 Flash: Multimodal Audio]
    GeminiAudio -->|JSON: Transcrição + Resumo executivo| Format2[Formatador de Áudio]
    Format2 -->|Envia no chat| User
```

---

## ✨ Funcionalidades Principais

* **🎧 Transcrição e Resumo de Áudio (`!ouvir`):** Responda a qualquer áudio do WhatsApp com `!ouvir` para o robô baixar a mídia, processar com IA multimodal e devolver o texto transcrito + os pontos principais.
* **🔍 Perguntas sobre a Conversa (`!pergunta <dúvida>`):** Pergunte qualquer coisa sobre o histórico recente (ex: *"Qual o preço combinado?"*, *"Quem vai levar o documento?"*) e a IA responde direto ao ponto.
* **📋 Resumo Estruturado com JSON Schema (`!resumo`):** Retorna visão geral, tópicos debatidos, decisões tomadas, pendências e um badge de urgência (🟢 Baixa / 🟡 Média / 🔴 Alta).
* **🔒 Trava de Segurança Antispam:** Por padrão, apenas você (o dono da conta do WhatsApp) pode acionar comandos nos grupos. Suporta adicionar números permitidos no `.env`.
* **⚡ Conexão WebSocket Direta:** Sem emuladores pesados de navegador; conexão leve e instantânea via protocolo Baileys.
* **💾 Ring Buffer em Memória:** Mantém apenas as mensagens mais recentes por chat, evitando consumo desnecessário de memória RAM.

---

## 🛠️ Tecnologias e Conceitos de Engenharia Aplicados

| Tecnologia / Conceito | Onde e Como foi Usado |
| :--- | :--- |
| **Node.js & TypeScript** | Tipagem estrita com `NodeNext`, garantindo robustez e autocompletion em todo o fluxo de dados. |
| **IA Multimodal (Áudio + Texto)** | Envio de buffers de áudio em Base64 diretamente para o Gemini 3.6 Flash para transcrição instantânea. |
| **Event-Driven Architecture** | Escuta reativa de eventos assíncronos (`messages.upsert`, `connection.update`) em vez de polling repetitivo. |
| **Structured Output (LLM)** | Elimina a imprevisibilidade de texto livre através de contratos de dados em JSON Schema. |
| **Ring Buffer (Fila Circular)** | Estrutura de dados em memória para descarte automático de mensagens antigas (`FIFO`). |
| **DevSecOps Hygiene** | Proteção contra vazamento de credenciais e tokens através de variáveis de ambiente (`.env`) e `.gitignore` rigoroso. |

---

## 🚀 Como Executar Localmente

### Pré-requisitos
* Node.js 18+ instalado
* Chave gratuita da API do Gemini (obtenha em [Google AI Studio](https://aistudio.google.com/))

### 1. Clonar o repositório
```bash
git clone https://github.com/Cassi-dev/wpp-ai-summarizer.git
cd wpp-ai-summarizer
```

### 2. Instalar dependências
```bash
npm install
```

### 3. Configurar variáveis de ambiente
Crie um arquivo `.env` na raiz (baseado no `.env.example`):
```env
GEMINI_API_KEY=sua_chave_do_gemini_aqui
COMMAND_PREFIX=!
ONLY_OWNER=true
```

### 4. Iniciar o bot
```bash
npm run dev
```

### 5. Conectar
1. O terminal exibirá um **QR Code**.
2. Abra o WhatsApp no celular ➔ toque nos **3 pontos** (ou Configurações) ➔ **Aparelhos Conectados** ➔ **Conectar um aparelho**.
3. Escaneie o QR Code e pronto!

---

## 🎮 Lista de Comandos no WhatsApp

| Comando | O que faz | Exemplo |
| :--- | :--- | :--- |
| `!resumo [n]` | Resume as conversas recentes daquele chat | `!resumo` ou `!resumo 30` |
| `!pergunta <dúvida>` | Pergunta pontual sobre o que conversaram | `!pergunta Qual o horário marcado?` |
| `!ouvir` | Responda a um áudio com este comando para transcrever e resumir | Responda ao áudio com `!ouvir` |
| `!limpar` | Esvazia o buffer de mensagens recentes daquela conversa | `!limpar` |
| `!ajuda` | Exibe o menu com todos os comandos disponíveis | `!ajuda` |

---

## 📄 Licença
Distribuído sob a licença MIT. Veja `LICENSE` para mais detalhes.

---
<div align="center">
Desenvolvido por <b>Cassiano</b> como parte do seu portfólio de engenharia de software e IA aplicada.
</div>
