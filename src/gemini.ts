import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { AudioSummaryResult, SummaryResult } from './types.js';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

/**
 * Inicializa a instância do cliente Gemini
 */
function getAIClient(): GoogleGenAI {
  if (!apiKey || apiKey.trim() === '' || apiKey === 'sua_chave_do_gemini_aqui') {
    throw new Error(
      'Chave GEMINI_API_KEY não configurada no arquivo .env! Obtenha sua chave gratuita em: https://aistudio.google.com/'
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Envia as mensagens da conversa para o Gemini e retorna um resumo estruturado via JSON Schema
 */
export async function generateChatSummary(messagesText: string): Promise<SummaryResult> {
  const ai = getAIClient();

  const prompt = `
Você é um assistente de inteligência e produtividade para WhatsApp.
Analise as mensagens abaixo e extraia um resumo executivo fiel, objetivo e bem estruturado.

MENSAGENS DO CHAT:
${messagesText}
`;

  // Chamada com Structured Output (Schema estrito)
  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          resumoGeral: {
            type: Type.STRING,
            description: 'Breve visão geral em 1 ou 2 frases do que foi conversado.',
          },
          assuntos: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Lista com os principais temas debatidos no grupo.',
          },
          decisoes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Decisões concretas tomadas pelo grupo ou combinados realizados.',
          },
          pendencias: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Tarefas pendentes, prazos ou ações que alguém precisa fazer.',
          },
          urgencia: {
            type: Type.STRING,
            enum: ['baixa', 'media', 'alta'],
            description: 'Classificação do nível de urgência do assunto tratado.',
          },
        },
        required: ['resumoGeral', 'assuntos', 'decisoes', 'pendencias', 'urgencia'],
      },
    },
  });

  const rawJson = response.text?.trim() || '{}';
  const summary: SummaryResult = JSON.parse(rawJson);

  return summary;
}

/**
 * Responde a uma pergunta específica feita pelo usuário com base no histórico da conversa
 */
export async function answerChatQuestion(messagesText: string, question: string): Promise<string> {
  const ai = getAIClient();

  const prompt = `
Você é um assistente de busca e consulta sobre conversas de WhatsApp.
Com base EXCLUSIVAMENTE nas mensagens recentes fornecidas abaixo, responda à pergunta do usuário de forma direta, precisa e amigável.
Se a informação não estiver presente nas mensagens, diga claramente que não encontrou menção a esse assunto no histórico recente.

MENSAGENS RECENTES:
${messagesText}

PERGUNTA DO USUÁRIO:
${question}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Não consegui obter uma resposta para esta pergunta.';
}

/**
 * Transcreve e resume um áudio do WhatsApp usando os recursos multimodais nativos do Gemini
 */
export async function transcribeAndSummarizeAudio(
  audioBase64: string,
  mimeType: string = 'audio/ogg'
): Promise<AudioSummaryResult> {
  const ai = getAIClient();

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [
      {
        inlineData: {
          mimeType,
          data: audioBase64,
        },
      },
      {
        text: `
Você é um assistente especializado em transcrever e resumir áudios do WhatsApp.
Por favor:
1. Transcreva com máxima precisão o que foi dito no áudio.
2. Forneça um resumo executivo rápido em 1 ou 2 frases.
3. Destaque os pontos-chave ou combinados mencionados.
`,
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          transcricao: {
            type: Type.STRING,
            description: 'Transcrição literal fiel do que foi dito no áudio.',
          },
          resumo: {
            type: Type.STRING,
            description: 'Resumo rápido em uma ou duas frases.',
          },
          pontosChave: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Principais pontos, números, datas ou acordos citados no áudio.',
          },
        },
        required: ['transcricao', 'resumo', 'pontosChave'],
      },
    },
  });

  const rawJson = response.text?.trim() || '{}';
  return JSON.parse(rawJson) as AudioSummaryResult;
}

/**
 * Transforma o objeto estruturado JSON em uma mensagem elegante formatada com markdown do WhatsApp
 */
export function formatSummaryForWhatsApp(summary: SummaryResult): string {
  const badgeUrgencia = {
    baixa: '🟢 *Baixa*',
    media: '🟡 *Média*',
    alta: '🔴 *ALTA - Atenção Necessária!*',
  }[summary.urgencia];

  const blocos = [
    `📋 *RESUMO INTELIGENTE DE CONVERSA*\n`,
    `📝 *Visão Geral:* ${summary.resumoGeral}\n`,
    `📌 *Assuntos Principais:*`,
    summary.assuntos.length > 0 ? summary.assuntos.map((a) => `• ${a}`).join('\n') : '• Nenhum assunto relevante',
    `\n✅ *Decisões Tomadas:*`,
    summary.decisoes.length > 0 ? summary.decisoes.map((d) => `• ${d}`).join('\n') : '• Nenhuma decisão registrada',
    `\n⚠️ *Pendências & Ações:*`,
    summary.pendencias.length > 0 ? summary.pendencias.map((p) => `• ${p}`).join('\n') : '• Nenhuma pendência',
    `\nPrioridade: ${badgeUrgencia}`,
    `\n_Gerado automaticamente com Gemini AI_ 🤖`,
  ];

  return blocos.join('\n');
}

/**
 * Formata a transcrição e resumo do áudio para exibição no WhatsApp
 */
export function formatAudioSummaryForWhatsApp(result: AudioSummaryResult): string {
  const blocos = [
    `🎙️ *TRANSCRIÇÃO DE ÁUDIO VIA GEMINI AI*\n`,
    `💬 *O que foi dito:*`,
    `"${result.transcricao}"\n`,
    `📝 *Resumo Rápido:* ${result.resumo}\n`,
  ];

  if (result.pontosChave && result.pontosChave.length > 0) {
    blocos.push(`🔑 *Pontos-Chave:*`);
    blocos.push(result.pontosChave.map((p) => `• ${p}`).join('\n'));
  }

  blocos.push(`\n_Transcrito e resumido sem precisar ouvir o áudio_ 🎧✨`);

  return blocos.join('\n');
}

/**
 * ✍️ GHOSTWRITER: Sugere 3 opções de resposta para uma mensagem
 */
export async function suggestReplies(messageText: string): Promise<string> {
  const ai = getAIClient();
  const prompt = `
Você é um ghostwriter e especialista em comunicação assertiva.
Analise a mensagem recebida abaixo e elabore 3 opções elegantes de resposta para o usuário enviar de volta.

MENSAGEM RECEBIDA:
"${messageText}"

Formate sua resposta EXATAMENTE com este modelo em markdown do WhatsApp:
✍️ *SUGESTÕES DE RESPOSTA*

1. 👔 *Profissional & Diplomática:*
(coloque o texto aqui)

2. 😊 *Amigável & Conciliadora:*
(coloque o texto aqui)

3. ⚡ *Direta & Firme:*
(coloque o texto aqui)

_Dica: Copie a que melhor se adapta à sua situação!_
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Não consegui formular sugestões no momento.';
}

/**
 * 💡 EXPLICADOR: Explica um termo, mensagem ou contexto complexo de forma simples
 */
export async function explainMessage(messageText: string): Promise<string> {
  const ai = getAIClient();
  const prompt = `
Você é um professor e simplificador de conteúdos.
Explique o significado, contexto e mensagem central do texto abaixo de forma clara, didática e acessível (como se estivesse explicando para alguém leigo).

TEXTO:
"${messageText}"

Formate sua resposta em markdown do WhatsApp:
💡 *EXPLICAÇÃO DA MENSAGEM*

📖 *O que significa:* (1 ou 2 parágrafos simples)

🔍 *Pontos Importantes:*
• (tópico 1)
• (tópico 2)

🎯 *Moral da história / Conclusão:* (1 frase)
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Não consegui analisar o texto.';
}

/**
 * 🌐 TRADUTOR: Traduz a mensagem para português brasileiro
 */
export async function translateMessage(messageText: string): Promise<string> {
  const ai = getAIClient();
  const prompt = `
Traduza o texto abaixo para Português do Brasil com máxima naturalidade e fluência.

TEXTO:
"${messageText}"

Formato de saída:
🌐 *TRADUÇÃO PARA PORTUGUÊS*

💬 *Tradução:*
(texto traduzido)

_Idioma detectado traduzido com sucesso_ ✨
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Erro ao traduzir mensagem.';
}

/**
 * 🎯 EXTRATOR DE TAREFAS: Extrai um checklist de afazeres de um texto longo
 */
export async function extractTasks(messageText: string): Promise<string> {
  const ai = getAIClient();
  const prompt = `
Você é um gestor de projetos ágil.
Extraia todas as tarefas, pendências, prazos e ações mencionadas no texto abaixo em formato de checklist de afazeres (To-Do List).

TEXTO:
"${messageText}"

Formato de saída:
🎯 *CHECKLIST DE TAREFAS EXTRAÍDO*

📋 *Ações a Fazer:*
- [ ] Tarefa 1 (Responsável / Prazo se houver)
- [ ] Tarefa 2

⚠️ *Atenção / Prazos Críticos:*
(se houver, destaque aqui)
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Nenhuma tarefa identificada.';
}

/**
 * 🕵️‍♂️ CHECADOR DE FATOS / FAKE NEWS: Analisa a credibilidade de um boato ou corrente
 */
export async function factCheckMessage(messageText: string): Promise<string> {
  const ai = getAIClient();
  const prompt = `
Você é um jornalista investigativo e analista de verificação de fatos (Fact-Checking).
Analise a mensagem abaixo e avalie se ela tem características de boato viral, corrente falsa, desinformação, golpe ou se parece plausível.

MENSAGEM:
"${messageText}"

Formato de saída:
🕵️‍♂️ *ANÁLISE DE CREDIBILIDADE & FACT-CHECK*

🛡️ *Classificação Geral:* (ex: 🟢 Confiável / 🟡 Duvidoso / 🔴 Alerta de Boato ou Golpe)

🔎 *Indícios Detectados:*
• (análise de linguagem sensacionalista, urgência falsa, falta de fontes, etc.)

💡 *Recomendação:*
(o que o usuário deve fazer antes de repassar)
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Não consegui checar os fatos desta mensagem.';
}

/**
 * 💰 DIVISOR DE DESPESAS / RACHID: Calcula a divisão de contas de uma mensagem
 */
export async function splitExpenses(messageText: string): Promise<string> {
  const ai = getAIClient();
  const prompt = `
Você é um assistente financeiro de divisão de despesas (rachid).
Analise os gastos listados abaixo e calcule a divisão matemática justa de quanto cada pessoa deve pagar ou receber.

MENSAGEM COM GASTOS:
"${messageText}"

Formato de saída:
💰 *DIVISÃO DE CONTAS / RACHID*

🧾 *Total Geral Calculado:* R$ ...

👥 *Quanto cada pessoa deve pagar:*
• Nome: R$ ...
• Nome: R$ ...

💳 *Resumo para Copiar e Cobrar no Grupo:*
(mensagem curta e amigável pronta para colar no grupo com chave Pix imaginária)
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Não consegui calcular a divisão de despesas.';
}

/**
 * 🔗 RESUMIDOR DE LINKS: Resumo executivo do conteúdo de uma URL
 */
export async function summarizeLinkContent(url: string, contextText: string): Promise<string> {
  const ai = getAIClient();
  const prompt = `
Analise o link e o contexto fornecidos e faça um resumo executivo em 3 tópicos dos pontos principais da matéria ou página.

URL: ${url}
CONTEXTO DA MENSAGEM: "${contextText}"

Formato de saída:
🔗 *RESUMO DO LINK*
🌐 *URL:* ${url}

📝 *Destaques Principais:*
• (ponto 1)
• (ponto 2)
• (ponto 3)

_Resumo executivo sem precisar abrir a página_ ⚡
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
  });

  return response.text?.trim() || 'Não consegui resumir o link.';
}

