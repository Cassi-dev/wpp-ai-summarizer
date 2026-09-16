import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { SummaryResult } from './types.js';

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
    model: 'gemini-2.5-flash',
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
