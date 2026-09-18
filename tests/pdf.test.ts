import { describe, expect, it } from 'vitest';
import { generateMeetingMinutesPdf, MeetingMinutesData } from '../src/pdf.js';

describe('PDF Engine - generateMeetingMinutesPdf', () => {
  it('deve gerar um Buffer binário de PDF válido com cabeçalho corporativo', async () => {
    const sampleData: MeetingMinutesData = {
      title: 'Alinhamento Semanal de Engenharia',
      chatName: 'Dev Team',
      date: '18/09/2026',
      participants: ['Cassiano', 'Ana', 'Bruno'],
      contextOverview: 'Reunião de alinhamento das entregas da sprint e planejamento de deploys.',
      keyTopics: ['Deploy do WhatsApp AI Summarizer', 'Migração de banco de dados'],
      decisions: ['Aprovada a arquitetura modular com Vitest e CI'],
      actionItems: [
        { task: 'Implementar testes unitários', assignee: 'Cassiano', deadline: 'Hoje' },
        { task: 'Revisar PR', assignee: 'Ana', deadline: 'Amanhã' },
      ],
    };

    const pdfBuffer = await generateMeetingMinutesPdf(sampleData);

    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(1000);

    // Validação da assinatura mágica de cabeçalho do padrão PDF (%PDF-1.)
    const header = pdfBuffer.slice(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });
});
