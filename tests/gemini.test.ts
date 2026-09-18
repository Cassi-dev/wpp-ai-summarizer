import { describe, expect, it } from 'vitest';
import {
  formatAudioSummaryForWhatsApp,
  formatSummaryForWhatsApp,
} from '../src/gemini.js';
import { AudioSummaryResult, SummaryResult } from '../src/types.js';

describe('Gemini Engine - Formatação de Resumos', () => {
  it('deve formatar resumo estruturado com marcadores de urgência corretos', () => {
    const mockSummary: SummaryResult = {
      resumoGeral: 'Discussão sobre o prazo de entrega.',
      assuntos: ['Prazo de entrega', 'Aprovação do cliente'],
      decisoes: ['Entrega mantida para sexta-feira'],
      pendencias: ['Enviar contrato assinado'],
      urgencia: 'alta',
    };

    const formatted = formatSummaryForWhatsApp(mockSummary);

    expect(formatted).toContain('RESUMO INTELIGENTE DE CONVERSA');
    expect(formatted).toContain('Discussão sobre o prazo de entrega.');
    expect(formatted).toContain('🔴 *ALTA - Atenção Necessária!*');
    expect(formatted).toContain('Enviar contrato assinado');
  });

  it('deve formatar transcrição de áudio com pontos-chave', () => {
    const mockAudio: AudioSummaryResult = {
      transcricao: 'Oi, estou ligando para avisar que o pagamento foi feito.',
      resumo: 'Aviso de confirmação de pagamento.',
      pontosChave: ['Pagamento realizado'],
    };

    const formatted = formatAudioSummaryForWhatsApp(mockAudio);

    expect(formatted).toContain('TRANSCRIÇÃO DE ÁUDIO VIA GEMINI AI');
    expect(formatted).toContain('Oi, estou ligando para avisar que o pagamento foi feito.');
    expect(formatted).toContain('Pagamento realizado');
  });
});
