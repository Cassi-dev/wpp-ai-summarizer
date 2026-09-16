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
