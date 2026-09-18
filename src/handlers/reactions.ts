import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { appDatabase } from '../database.js';
import {
  analyzeImageOrDocument,
  explainMessage,
  extractTasks,
  factCheckMessage,
  formatAudioSummaryForWhatsApp,
  formatSummaryForWhatsApp,
  generateChatSummary,
  generateMeetingMinutesData,
  splitExpenses,
  suggestReplies,
  summarizeLinkContent,
  transcribeAndSummarizeAudio,
  translateMessage,
} from '../gemini.js';
import { generateMeetingMinutesPdf } from '../pdf.js';
import { formatAiErrorMessage } from '../utils.js';

/**
 * Processador dedicado para todas as Reações com Emojis (Gatilhos Invisíveis no Privado)
 */
export async function handleReactionTrigger(
  sock: any,
  msg: WAMessage,
  reaction: any,
  ownerJid: string,
  defaultSummaryLimit: number
): Promise<void> {
  const emoji = reaction.text?.trim();
  const targetChatJid = reaction.key?.remoteJid;
  const targetMsgId = reaction.key?.id;

  if (!targetChatJid) return;

  const isGrp = targetChatJid.endsWith('@g.us');
  const chatTitle = isGrp ? 'Grupo' : 'Conversa Privada';

  // 1. BUSCA A MENSAGEM ALVO NO BANCO DE DADOS
  const targetMsg = appDatabase.getMessageById(targetMsgId || '');

  // 1.1 PROCESSAMENTO MULTIMODAL (FOTOS, COMPROVANTES, DOCUMENTOS E ÁUDIOS)
  let rawMsgContent: any = null;
  if (targetMsg?.rawMessage) {
    try {
      rawMsgContent = JSON.parse(targetMsg.rawMessage);
    } catch {}
  }
  const isImageOrDoc = Boolean(rawMsgContent?.imageMessage || rawMsgContent?.documentMessage);
  const isAudio = Boolean(rawMsgContent?.audioMessage);

  // 1. EMOJI 🧠: RESUMO DO CHAT (se a mensagem-alvo for imagem/documento, cai no gatilho multimodal abaixo)
  if (emoji === '🧠' && !isImageOrDoc) {
    console.log(`\n🧠 [Gatilho 🧠]: Resumindo chat ${targetChatJid} (limite: ${defaultSummaryLimit} mensagens)...`);
    const recentMessages = appDatabase.getRecentMessages(targetChatJid, defaultSummaryLimit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ [${chatTitle}] Poucas mensagens registradas no SQLite para gerar um resumo (mínimo de 3 mensagens).`,
      });
      return;
    }

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);
      appDatabase.saveSummary(targetChatJid, summaryResult);

      const responseMessage =
        `👻 *[MODO FANTASMA INVISÍVEL 🧠]*\n📋 *Resumo de: ${chatTitle}*\n\n` +
        formatSummaryForWhatsApp(summaryResult);

      await sock.sendMessage(ownerJid, { text: responseMessage });
      console.log(`✅ Resumo 🧠 entregue com sucesso no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🧠:', err);
      await sock.sendMessage(ownerJid, {
        text: `❌ Falha ao processar resumo: ${formatAiErrorMessage(err, 'o resumo')}`,
      });
    }
    return;
  }

  // EMOJI 📄 / 📑: GERADOR DE ATA FORMAL EM PDF
  if (emoji === '📄' || emoji === '📑') {
    console.log(`\n📄 [Gatilho 📄]: Gerando ata formal em PDF de ${targetChatJid}...`);
    const recentMessages = appDatabase.getRecentMessages(targetChatJid, defaultSummaryLimit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ [${chatTitle}] Poucas mensagens registradas no SQLite para gerar uma ata em PDF (mínimo de 3 mensagens).`,
      });
      return;
    }

    try {
      await sock.sendMessage(ownerJid, {
        text: `📄 *Gerando Ata Executiva em PDF de [${chatTitle}]...* Aguarde alguns instantes! ⏳`,
      });

      let groupSubject = chatTitle;
      if (isGrp) {
        try {
          const meta = await sock.groupMetadata(targetChatJid).catch(() => null);
          if (meta?.subject) groupSubject = meta.subject;
        } catch {}
      }

      const formattedChat = appDatabase.formatForAI(recentMessages);
      const minutesData = await generateMeetingMinutesData(formattedChat, groupSubject);
      const pdfBuffer = await generateMeetingMinutesPdf(minutesData);

      const safeTitle = groupSubject.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
      const fileName = `Ata_${safeTitle}_${Date.now()}.pdf`;

      const caption =
        `👻 *[MODO FANTASMA - ATA EXECUTIVA EM PDF 📄]*\n\n` +
        `📌 *Título:* ${minutesData.title}\n` +
        `📅 *Data:* ${minutesData.date}\n` +
        `👥 *Participantes:* ${minutesData.participants.join(', ') || 'Equipe'}\n\n` +
        `_Documento PDF formal gerado silenciosamente via reação 📄!_ ✨`;

      await sock.sendMessage(ownerJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName,
        caption,
      });
      console.log(`✅ Ata em PDF entregue com sucesso no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 📄:', err);
      await sock.sendMessage(ownerJid, {
        text: `❌ Falha ao gerar ata em PDF: ${formatAiErrorMessage(err, 'a ata em PDF')}`,
      });
    }
    return;
  }

  // GATILHO MULTIMODAL: FOTOS, COMPROVANTES OU DOCUMENTOS (reagiu com 📸, 💡, 🔍 ou 🧠)
  if (isImageOrDoc && (emoji === '📸' || emoji === '💡' || emoji === '🔍' || emoji === '🧠')) {
    console.log(`\n📸 [Visão Multimodal]: Baixando e analisando imagem/documento com Gemini AI...`);
    try {
      const fakeMsg: WAMessage = {
        key: {
          remoteJid: targetChatJid,
          id: targetMsgId,
        },
        message: rawMsgContent,
      };

      const mediaBuffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );

      const mimeType =
        rawMsgContent.imageMessage?.mimetype ||
        rawMsgContent.documentMessage?.mimetype ||
        'image/jpeg';

      const caption =
        rawMsgContent.imageMessage?.caption ||
        rawMsgContent.documentMessage?.caption ||
        targetMsg?.text ||
        '';

      const analysis = await analyzeImageOrDocument(mediaBuffer.toString('base64'), mimeType, caption);
      await sock.sendMessage(ownerJid, {
        text: `👻 *[VISÃO DE IMAGEM / DOCUMENTO 📸 - ${chatTitle}]*\n\n` + analysis,
      });
      console.log(`✅ Análise de imagem/documento entregue no privado!`);
      return;
    } catch (err: any) {
      console.error('Erro ao baixar e analisar imagem por reação:', err);
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Não foi possível baixar a imagem para análise: ${err.message || 'Mídia indisponível'}`,
      });
      return;
    }
  }

  // GATILHO MULTIMODAL: ÁUDIO (reagiu com 🎧 ou 💡)
  if (isAudio && (emoji === '🎧' || emoji === '💡')) {
    console.log(`\n🎧 [Áudio Multimodal]: Baixando e transcrevendo áudio com Gemini AI...`);
    try {
      const fakeMsg: WAMessage = {
        key: {
          remoteJid: targetChatJid,
          id: targetMsgId,
        },
        message: rawMsgContent,
      };

      const audioBuffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );

      const mimeType = rawMsgContent.audioMessage?.mimetype || 'audio/ogg';
      const audioResult = await transcribeAndSummarizeAudio(audioBuffer.toString('base64'), mimeType);
      const reply =
        `👻 *[TRANSCRIÇÃO DE ÁUDIO 🎧 - ${chatTitle}]*\n\n` +
        formatAudioSummaryForWhatsApp(audioResult);

      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Transcrição de áudio entregue no privado!`);
      return;
    } catch (err: any) {
      console.error('Erro ao transcrever áudio por reação:', err);
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Não foi possível transcrever este áudio: ${err.message || 'Falha no download'}`,
      });
      return;
    }
  }

  // 3. EMOJI 📌: SALVAR NOTA NOS FAVORITOS DO SQLITE
  if (emoji === '📌') {
    console.log(`\n📌 [Gatilho 📌]: Fixando mensagem nos favoritos...`);
    if (!targetMsg) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Mensagem não encontrada no banco SQLite para fixar.`,
      });
      return;
    }

    appDatabase.savePinnedNote(
      targetMsg.id,
      targetChatJid,
      chatTitle,
      targetMsg.senderName,
      targetMsg.text
    );

    const conf = `📌 *MENSAGEM SALVA NOS SEUS FAVORITOS (SQLite)*\n\n🏷️ *Origem:* ${chatTitle}\n👤 *Autor:* ${targetMsg.senderName}\n💬 *Conteúdo:* "${targetMsg.text}"\n\n_Digite !notas no seu privado para ver todas as notas salvas!_`;
    await sock.sendMessage(ownerJid, { text: conf });
    console.log(`✅ Nota fixada com sucesso no SQLite!`);
    return;
  }

  // Se for qualquer outra ação que exige texto da mensagem
  if (!targetMsg) {
    console.log(`ℹ️ Mensagem [${targetMsgId}] não encontrada no banco para a ação do emoji ${emoji}`);
    return;
  }

  // 4. EMOJI ✍️: GHOSTWRITER (SUGESTÕES DE RESPOSTA)
  if (emoji === '✍️' || emoji === '✍') {
    console.log(`\n✍️ [Gatilho ✍️]: Gerando opções de resposta para mensagem de ${targetMsg.senderName}...`);
    try {
      const suggestions = await suggestReplies(targetMsg.text);
      const reply = `👻 *[GHOSTWRITER ✍️ - ${chatTitle}]*\n👤 *Mensagem de ${targetMsg.senderName}:* "${targetMsg.text}"\n\n` + suggestions;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Sugestões de resposta entregues no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho ✍️:', err);
    }
    return;
  }

  // 5. EMOJI 💡: EXPLICADOR DIDÁTICO
  if (emoji === '💡') {
    console.log(`\n💡 [Gatilho 💡]: Explicando mensagem de ${targetMsg.senderName}...`);
    try {
      const explanation = await explainMessage(targetMsg.text);
      const reply = `👻 *[EXPLICADOR 💡 - ${chatTitle}]*\n💬 *Texto Original:* "${targetMsg.text}"\n\n` + explanation;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Explicação 💡 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 💡:', err);
    }
    return;
  }

  // 6. EMOJI 🌐: TRADUTOR PARA PORTUGUÊS
  if (emoji === '🌐' || emoji === '🌍') {
    console.log(`\n🌐 [Gatilho 🌐]: Traduzindo mensagem...`);
    try {
      const translation = await translateMessage(targetMsg.text);
      const reply = `👻 *[TRADUTOR 🌐 - ${chatTitle}]*\n💬 *Original:* "${targetMsg.text}"\n\n` + translation;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Tradução 🌐 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🌐:', err);
    }
    return;
  }

  // 7. EMOJI 🎯: EXTRATOR DE TAREFAS (TO-DO LIST)
  if (emoji === '🎯' || emoji === '📋') {
    console.log(`\n🎯 [Gatilho 🎯]: Extraindo tarefas da mensagem...`);
    try {
      const tasks = await extractTasks(targetMsg.text);
      const reply = `👻 *[EXTRATOR DE TAREFAS 🎯 - ${chatTitle}]*\n💬 *Contexto:* "${targetMsg.text}"\n\n` + tasks;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Checklist 🎯 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🎯:', err);
    }
    return;
  }

  // 8. EMOJI 🕵️‍♂️: CHECADOR DE FATOS / FAKE NEWS
  if (emoji === '🕵️‍♂️' || emoji === '🕵️' || emoji === '🔍') {
    console.log(`\n🕵️‍♂️ [Gatilho 🕵️‍♂️]: Checando fatos e credibilidade da mensagem...`);
    try {
      const factCheck = await factCheckMessage(targetMsg.text);
      const reply = `👻 *[FACT-CHECK 🕵️‍♂️ - ${chatTitle}]*\n💬 *Mensagem Analisada:* "${targetMsg.text}"\n\n` + factCheck;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Análise de fatos 🕵️‍♂️ entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🕵️‍♂️:', err);
    }
    return;
  }

  // 9. EMOJI 💰: DIVISOR DE CONTAS / RACHID
  if (emoji === '💰' || emoji === '🧾') {
    console.log(`\n💰 [Gatilho 💰]: Calculando divisão de despesas...`);
    try {
      const expenses = await splitExpenses(targetMsg.text);
      const reply = `👻 *[DIVISOR DE CONTAS 💰 - ${chatTitle}]*\n💬 *Gastos Listados:* "${targetMsg.text}"\n\n` + expenses;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Divisão de contas 💰 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 💰:', err);
    }
    return;
  }

  // 10. EMOJI 🔗: RESUMO DE LINK
  if (emoji === '🔗' || emoji === '📰') {
    console.log(`\n🔗 [Gatilho 🔗]: Resumindo link da mensagem...`);
    const urlMatch = targetMsg.text.match(/https?:\/\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0] : '';

    if (!url) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Nenhum link (URL) foi detectado na mensagem para resumir.`,
      });
      return;
    }

    try {
      const linkSummary = await summarizeLinkContent(url, targetMsg.text);
      const reply = `👻 *[LEITOR DE LINKS 🔗 - ${chatTitle}]*\n\n` + linkSummary;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Resumo do link 🔗 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🔗:', err);
    }
    return;
  }
}
