import PDFDocument from 'pdfkit';

export interface MeetingMinutesData {
  title: string;
  chatName: string;
  date: string;
  participants: string[];
  contextOverview: string;
  keyTopics: string[];
  decisions: string[];
  actionItems: Array<{ task: string; assignee?: string; deadline?: string }>;
}

/**
 * Gera um arquivo PDF executivo elegante e formal a partir dos dados estruturados da ata
 */
export function generateMeetingMinutesPdf(data: MeetingMinutesData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Cores da Identidade Visual Executiva
    const primaryColor = '#1E3A8A'; // Azul corporativo escuro
    const secondaryColor = '#475569'; // Cinza ardósia
    const darkColor = '#0F172A'; // Preto suave
    const accentColor = '#2563EB'; // Azul vibrante
    const boxBgColor = '#F1F5F9'; // Cinza muito claro

    // 1. CABEÇALHO DO DOCUMENTO
    doc.rect(50, 45, doc.page.width - 100, 4).fill(primaryColor);

    doc.moveDown(1.5);
    doc
      .fontSize(20)
      .font('Helvetica-Bold')
      .fillColor(primaryColor)
      .text('ATA DE ALINHAMENTO & REUNIÃO', { align: 'center' });

    doc
      .fontSize(11)
      .font('Helvetica')
      .fillColor(secondaryColor)
      .text(data.title || 'Resumo Executivo de Alinhamento', { align: 'center' });

    doc.moveDown(1.5);

    // 2. CAIXA DE METADADOS (DATA, GRUPO E PARTICIPANTES)
    const boxTop = doc.y;
    doc
      .roundedRect(50, boxTop, doc.page.width - 100, 70, 6)
      .fillAndStroke(boxBgColor, '#CBD5E1');

    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor(primaryColor)
      .text('📅 Data do Registro:', 65, boxTop + 12)
      .font('Helvetica')
      .fillColor(darkColor)
      .text(data.date, 175, boxTop + 12);

    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor(primaryColor)
      .text('💬 Origem / Canal:', 65, boxTop + 28)
      .font('Helvetica')
      .fillColor(darkColor)
      .text(data.chatName, 175, boxTop + 28);

    const participantsText =
      data.participants && data.participants.length > 0
        ? data.participants.slice(0, 8).join(', ') + (data.participants.length > 8 ? '...' : '')
        : 'Integrantes do grupo';

    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor(primaryColor)
      .text('👥 Participantes:', 65, boxTop + 44)
      .font('Helvetica')
      .fillColor(darkColor)
      .text(participantsText, 175, boxTop + 44);

    doc.y = boxTop + 90;

    // 3. SEÇÃO: VISÃO GERAL / CONTEXTO
    if (data.contextOverview) {
      doc
        .fontSize(13)
        .font('Helvetica-Bold')
        .fillColor(primaryColor)
        .text('1. Contexto & Visão Geral');

      doc.moveDown(0.4);
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor(darkColor)
        .text(data.contextOverview, { align: 'justify', lineGap: 3 });

      doc.moveDown(1.2);
    }

    // 4. SEÇÃO: PRINCIPAIS TÓPICOS DISCUTIDOS
    if (data.keyTopics && data.keyTopics.length > 0) {
      doc
        .fontSize(13)
        .font('Helvetica-Bold')
        .fillColor(primaryColor)
        .text('2. Pautas & Assuntos Abordados');

      doc.moveDown(0.4);
      data.keyTopics.forEach((topic) => {
        doc
          .fontSize(10)
          .font('Helvetica')
          .fillColor(darkColor)
          .text(`• ${topic}`, { indent: 10, lineGap: 2 });
      });

      doc.moveDown(1.2);
    }

    // 5. SEÇÃO: DECISÕES TOMADAS
    if (data.decisions && data.decisions.length > 0) {
      doc
        .fontSize(13)
        .font('Helvetica-Bold')
        .fillColor(primaryColor)
        .text('3. Decisões Estabelecidas');

      doc.moveDown(0.4);
      data.decisions.forEach((dec) => {
        doc
          .fontSize(10)
          .font('Helvetica-Bold')
          .fillColor('#047857') // Verde elegante de confirmação
          .text('✓ ', { continued: true, indent: 10 })
          .font('Helvetica')
          .fillColor(darkColor)
          .text(dec, { lineGap: 2 });
      });

      doc.moveDown(1.2);
    }

    // 6. SEÇÃO: PLANO DE AÇÃO & PRÓXIMOS PASSOS
    if (data.actionItems && data.actionItems.length > 0) {
      doc
        .fontSize(13)
        .font('Helvetica-Bold')
        .fillColor(primaryColor)
        .text('4. Plano de Ação & Próximos Passos');

      doc.moveDown(0.4);
      data.actionItems.forEach((item, index) => {
        const responsavel = item.assignee ? ` [Resp: ${item.assignee}]` : '';
        const prazo = item.deadline ? ` (Prazo: ${item.deadline})` : '';

        doc
          .fontSize(10)
          .font('Helvetica-Bold')
          .fillColor(accentColor)
          .text(`${index + 1}. `, { continued: true, indent: 10 })
          .font('Helvetica')
          .fillColor(darkColor)
          .text(`${item.task}${responsavel}${prazo}`, { lineGap: 2 });
      });

      doc.moveDown(1.5);
    }

    // 7. RODAPÉ DO DOCUMENTO
    const footerY = doc.page.height - 45;
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor('#94A3B8')
      .text(
        'Documento formal gerado automaticamente via WhatsApp AI Copilot • Powered by Google Gemini 3.8 Flash',
        50,
        footerY,
        { align: 'center', width: doc.page.width - 100 }
      );

    doc.end();
  });
}
