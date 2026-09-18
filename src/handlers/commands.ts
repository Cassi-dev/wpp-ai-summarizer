import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { appDatabase } from '../database.js';
import {
  answerChatQuestion,
  formatAudioSummaryForWhatsApp,
  formatSummaryForWhatsApp,
  generateChatSummary,
  generateMeetingMinutesData,
  transcribeAndSummarizeAudio,
} from '../gemini.js';
import { generateMeetingMinutesPdf } from '../pdf.js';
import { formatAiErrorMessage } from '../utils.js';
import { handleFocusCommand } from './focus.js';

export interface CommandContext {
  sock: any;
  msg: WAMessage;
  remoteJid: string;
  ownerJid: string;
  senderName: string;
  command: string;
  cleanArgs: string[];
  shouldSendPrivate: boolean;
  destinationJid: string;
  chatContextLabel: string;
  isGroup: boolean;
  defaultSummaryLimit: number;
  briefingTime: string;
  commandPrefix: string;
  runMorningBriefing: (sock: any, destinationOverride?: string) => Promise<void>;
}

/**
 * Processador central de comandos de texto (ex: !resumo, !ata, !foco, etc.)
 */
export async function handleTextCommand(ctx: CommandContext): Promise<void> {
  const {
    sock,
    msg,
    remoteJid,
    ownerJid,
    senderName,
    command,
    cleanArgs,
    shouldSendPrivate,
    destinationJid,
    chatContextLabel,
    isGroup,
    defaultSummaryLimit,
    briefingTime,
    commandPrefix,
    runMorningBriefing,
  } = ctx;

  // COMANDO: !emojis ou !emoji ou !superpoderes ou !menu
  if (command === 'emojis' || command === 'emoji' || command === 'superpoderes' || command === 'menu') {
    const guide = `🎛️ *CATÁLOGO DE SUPERPODERES INVISÍVEIS (REAÇÕES)* 🤫

Reaja com qualquer um destes emojis em qualquer mensagem de qualquer chat para ativar a IA em silêncio absoluto (a resposta chega somente no seu privado!):

🧠 *[Cérebro]* ➔ *Resumo Completo:*
Lê as últimas mensagens daquele chat e gera um resumo executivo com tópicos, decisões e urgência.

✍️ *[Caneta]* ➔ *Ghostwriter de Respostas:*
Gera 3 opções elegantes de resposta para você enviar de volta (Profissional, Amigável ou Direta).

💡 *[Lâmpada]* ➔ *Explicador Didático:*
Explica um termo técnico, texto longo ou assunto confuso em linguagem simples.

📸 *[Câmera]* ➔ *Visão de Fotos & Documentos:*
Reaja em fotos de comprovantes Pix, contratos, recibos ou gráficos para ter uma análise detalhada.

📄 *[Documento]* ➔ *Gerador de Ata em PDF:*
Reaja em qualquer conversa para gerar instantaneamente uma Ata Formal de Reunião em arquivo PDF!

📌 *[Alfinete]* ➔ *Fixar nos Favoritos (SQLite):*
Salva a mensagem marcada no seu banco de dados local. Digite \`!notas\` para consultar!

🌐 *[Globo]* ➔ *Tradutor Instantâneo:*
Traduz a mensagem para Português do Brasil com máxima naturalidade.

🎯 *[Alvo]* ➔ *Extrator de Tarefas (To-Do List):*
Transforma textões de alinhamento em um checklist de afazeres com prazos.

🕵️‍♂️ *[Detetive]* ➔ *Checador de Fatos / Fake News:*
Analisa indícios de boatos, correntes falsas, sensacionalismo ou golpes.

💰 *[Dinheiro]* ➔ *Divisor de Contas / Rachid:*
Calcula a divisão matemática exata dos gastos e quem deve quanto no Pix.

🔗 *[Link]* ➔ *Resumidor de Links:*
Resume o conteúdo e os pontos principais de um link sem você precisar abrir a página.

🎧 *[Fones]* ➔ *Ouvinte de Áudio:*
Transcreve e resume áudios sem precisar ouvir.

━━━━━━━━━━━━━━━━━━━━
🚀 *SUPERPODERES ADICIONAIS POR COMANDO:*

🔕 *\`!foco 2h\`* (ou \`!foco off\` / \`!foco status\`)
Ativa o Modo Foco com Secretária Eletrônica: silencia o privado, avisa educadamente quem te chamar até seu retorno e te dá um relatório ao final!

📄 *\`!ata [n]\` ou \`!pdf [n]\`* (adicione \`pv\` para segredo)
Gera uma Ata Formal de Reunião em PDF com layout executivo (pautas, decisões e plano de ação).

☀️ *\`!briefing\`*
Consolida em uma mensagem o que aconteceu nas últimas 24h dos grupos (automático às ${briefingTime}).

🚨 *Radar de Urgência Ativo:*
Monitora grupos e te avisa no privado em tempo real se chamarem seu nome ou palavras urgentes!

━━━━━━━━━━━━━━━━━━━━
💡 _Dica: No chat onde você reage, nada é enviado nem apagado. Ninguém vê nada além da sua reação!_`;

    await sock.sendMessage(destinationJid, { text: guide });
  }

  // COMANDO: !briefing (Dispara o briefing matinal consolidado sob demanda)
  else if (command === 'briefing') {
    await sock.sendMessage(destinationJid, {
      text: `☀️ *Preparando seu Briefing Executivo...* Consultando conversas das últimas 24h com o Gemini AI! ⏳`,
    });
    await runMorningBriefing(sock, destinationJid);
  }

  // COMANDO: !notas (LISTA TODAS AS MENSAGENS FIXADAS COM 📌)
  else if (command === 'notas') {
    const notes = appDatabase.getPinnedNotes(15);
    if (notes.length === 0) {
      await sock.sendMessage(destinationJid, {
        text: `📌 Nenhuma nota fixada ainda. Reaja com o emoji 📌 em qualquer mensagem para arquivá-la aqui!`,
      });
      return;
    }

    const items = notes
      .map((n, i) => {
        const data = n.date.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        return `${i + 1}. 📌 *[${n.chatTitle}]* (${data}) - *${n.senderName}*:\n"${n.text}"`;
      })
      .join('\n\n');

    await sock.sendMessage(destinationJid, {
      text: `📋 *SUAS NOTAS E MENSAGENS FIXADAS (SQLite):*\n\n${items}`,
    });
  }

  // COMANDO: !foco [tempo / off / status] (MODO FOCO COM SECRETÁRIA ELETRÔNICA)
  else if (command === 'foco') {
    await handleFocusCommand(sock, destinationJid, cleanArgs);
  }

  // COMANDO: !ata ou !pdf [n] [pv] (GERADOR DE ATA EXECUTIVA EM PDF)
  else if (command === 'ata' || command === 'pdf') {
    const limit = cleanArgs[0] && !isNaN(Number(cleanArgs[0])) ? Math.min(Number(cleanArgs[0]), 200) : defaultSummaryLimit;
    const recentMessages = appDatabase.getRecentMessages(remoteJid, limit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(destinationJid, {
        text: `⚠️ [${chatContextLabel}] Poucas mensagens registradas no SQLite para gerar uma ata formal em PDF (mínimo de 3 mensagens). Converse um pouco e tente de novo!`,
      });
      return;
    }

    await sock.sendMessage(destinationJid, {
      text: `📄 *Gerando Ata Executiva em PDF de [${chatContextLabel}]...* Analisando pautas, decisões e plano de ação com Gemini AI! ⏳`,
    });

    try {
      let groupSubject = chatContextLabel;
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(remoteJid).catch(() => null);
          if (meta?.subject) groupSubject = meta.subject;
        } catch {}
      }

      const formattedChat = appDatabase.formatForAI(recentMessages);
      const minutesData = await generateMeetingMinutesData(formattedChat, groupSubject);
      const pdfBuffer = await generateMeetingMinutesPdf(minutesData);

      const safeTitle = groupSubject.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
      const fileName = `Ata_${safeTitle}_${Date.now()}.pdf`;

      let caption =
        `📄 *ATA EXECUTIVA DE REUNIÃO / ALINHAMENTO*\n\n` +
        `📌 *Título:* ${minutesData.title}\n` +
        `📅 *Data:* ${minutesData.date}\n` +
        `👥 *Participantes:* ${minutesData.participants.join(', ') || 'Equipe'}\n\n` +
        `_Documento PDF formal de alta fidelidade gerado com sucesso!_ ✨`;

      if (shouldSendPrivate) {
        caption = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + caption;
      }

      await sock.sendMessage(destinationJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName,
        caption,
      });
      console.log(`✅ Ata em PDF entregue com sucesso para: ${destinationJid}`);
    } catch (err: any) {
      console.error('Erro ao gerar ata em PDF:', err);
      await sock.sendMessage(destinationJid, {
        text: `❌ Falha ao gerar ata em PDF: ${formatAiErrorMessage(err, 'a ata em PDF')}`,
      });
    }
  }

  // COMANDO 1: !resumo [n] [pv]
  else if (command === 'resumo') {
    const limit = cleanArgs[0] && !isNaN(Number(cleanArgs[0])) ? Math.min(Number(cleanArgs[0]), 200) : defaultSummaryLimit;
    const recentMessages = appDatabase.getRecentMessages(remoteJid, limit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(destinationJid, {
        text: `⚠️ Ainda não há mensagens suficientes gravadas no SQLite para gerar um resumo (mínimo de 3 mensagens). Converse um pouco e tente de novo!`,
      });
      return;
    }

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);

      appDatabase.saveSummary(remoteJid, summaryResult);

      let responseMessage = formatSummaryForWhatsApp(summaryResult);
      if (shouldSendPrivate) {
        responseMessage = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + responseMessage;
      }

      await sock.sendMessage(destinationJid, { text: responseMessage });
      console.log(`✅ Resumo entregue com sucesso para: ${destinationJid}`);
    } catch (error: any) {
      console.error('Erro ao gerar resumo:', error);
      await sock.sendMessage(destinationJid, {
        text: `❌ Falha ao processar resumo: ${formatAiErrorMessage(error, 'o resumo')}`,
      });
    }
  }

  // COMANDO 2: !pergunta [pv] <dúvida sobre o histórico do chat>
  else if (command === 'pergunta') {
    const question = cleanArgs.join(' ').trim();

    if (!question) {
      await sock.sendMessage(destinationJid, {
        text: `💡 *Como usar:* Digite \`${commandPrefix}pergunta <sua dúvida>\` (adicione \`pv\` para receber no privado).\nExemplo: \`${commandPrefix}pergunta pv Qual o horário da reunião?\``,
      });
      return;
    }

    const recentMessages = appDatabase.getRecentMessages(remoteJid, 100);
    if (recentMessages.length === 0) {
      await sock.sendMessage(destinationJid, {
        text: `⚠️ Nenhuma mensagem encontrada no banco SQLite de [${chatContextLabel}] para responder sua pergunta.`,
      });
      return;
    }

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const answer = await answerChatQuestion(formattedChat, question);

      let reply = `❓ *Pergunta:* ${question}\n\n💡 *Resposta da IA:*\n${answer}\n\n_Baseado no histórico de [${chatContextLabel}]_ 🗄️🤖`;
      if (shouldSendPrivate) {
        reply = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + reply;
      }

      await sock.sendMessage(destinationJid, { text: reply });
      console.log(`✅ Resposta de pergunta entregue para: ${destinationJid}`);
    } catch (error: any) {
      console.error('Erro ao responder pergunta:', error);
      await sock.sendMessage(destinationJid, {
        text: `❌ Erro ao consultar IA: ${formatAiErrorMessage(error, 'a resposta')}`,
      });
    }
  }

  // COMANDO 3: !buscar [pv] <palavra>
  else if (command === 'buscar') {
    const query = cleanArgs.join(' ').trim();

    if (!query) {
      await sock.sendMessage(destinationJid, {
        text: `🔍 *Como usar:* Digite \`${commandPrefix}buscar <palavra>\` (adicione \`pv\` para receber no privado).`,
      });
      return;
    }

    const matches = appDatabase.searchMessages(remoteJid, query, 5);

    if (matches.length === 0) {
      await sock.sendMessage(destinationJid, {
        text: `🔍 Nenhuma mensagem encontrada com o termo "${query}" no banco SQLite de [${chatContextLabel}].`,
      });
      return;
    }

    const resultados = matches
      .map((m) => {
        const data = m.timestamp.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        return `📅 [${data}] *${m.senderName}*: "${m.text}"`;
      })
      .join('\n\n');

    let msgText = `🗄️ *MENSAGENS ENCONTRADAS EM [${chatContextLabel}] ("${query}"):*\n\n${resultados}`;
    if (shouldSendPrivate) {
      msgText = `👻 *[MODO FANTASMA]*\n\n` + msgText;
    }

    await sock.sendMessage(destinationJid, { text: msgText });
  }

  // COMANDO 4: !historico [pv]
  else if (command === 'historico') {
    const last = appDatabase.getLastSummary(remoteJid);

    if (!last) {
      await sock.sendMessage(destinationJid, {
        text: `ℹ️ Nenhum resumo anterior foi encontrado no banco de dados para [${chatContextLabel}]. Use \`${commandPrefix}resumo\` primeiro!`,
      });
      return;
    }

    const dataFormatada = last.date.toLocaleString('pt-BR');
    let msgFormatted =
      `📑 *ÚLTIMO RESUMO ARQUIVADO DE [${chatContextLabel}]* (Gerado em ${dataFormatada}):\n\n` +
      formatSummaryForWhatsApp(last.summary);

    if (shouldSendPrivate) {
      msgFormatted = `👻 *[MODO FANTASMA]*\n\n` + msgFormatted;
    }

    await sock.sendMessage(destinationJid, { text: msgFormatted });
  }

  // COMANDO 5: !ouvir [pv]
  else if (command === 'ouvir' || command === 'audio') {
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isAudioQuote = Boolean(quotedMsg?.audioMessage);

    if (!isAudioQuote) {
      await sock.sendMessage(destinationJid, {
        text: `🎙️ *Como usar:* Responda a qualquer mensagem de áudio digitando \`${commandPrefix}ouvir\` (ou \`${commandPrefix}ouvir pv\` para receber no privado)!`,
      });
      return;
    }

    try {
      const audioBuffer = await downloadMediaMessage(
        {
          key: {
            remoteJid,
            id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
            participant: msg.message?.extendedTextMessage?.contextInfo?.participant,
          },
          message: quotedMsg,
        } as any,
        'buffer',
        {},
        {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sock.updateMediaMessage,
        }
      );

      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      const mimeType = quotedMsg?.audioMessage?.mimetype || 'audio/ogg; codecs=opus';

      const audioResult = await transcribeAndSummarizeAudio(base64Audio, mimeType);
      let replyMessage = formatAudioSummaryForWhatsApp(audioResult);

      if (shouldSendPrivate) {
        replyMessage = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + replyMessage;
      }

      await sock.sendMessage(destinationJid, { text: replyMessage });
      console.log(`✅ Áudio transcrito e entregue para: ${destinationJid}`);
    } catch (error: any) {
      console.error('Erro ao transcrever áudio:', error);
      await sock.sendMessage(destinationJid, {
        text: `❌ Falha ao processar o áudio com IA: ${error.message || 'Erro ao decodificar áudio'}`,
      });
    }
  }

  // COMANDO 6: !ajuda ou !help
  else if (command === 'ajuda' || command === 'help') {
    const helpText = `🤖 *WhatsApp AI Summarizer - Menu Principal*

• \`!emojis\` ou \`!superpoderes\`
  Exibe o catálogo completo de reações por emojis invisíveis!

• \`!foco [tempo]\` (ex: \`!foco 2h\`, \`!foco 45m\`, \`!foco off\`)
  Ativa o Modo Foco com Secretária Eletrônica para silenciar mensagens no privado.

• \`!ata [n]\` ou \`!pdf [n]\` (adicione \`pv\` para segredo)
  Gera uma Ata Executiva de Reunião formal em PDF com pautas e decisões.

• \`!briefing\`
  Gera o relatório executivo matinal consolidado das últimas 24h dos grupos.

• \`!notas\`
  Lista todas as mensagens e notas que você fixou com 📌 no SQLite.

• \`!resumo [n]\` (adicione \`pv\` para segredo)
  Gera resumo das últimas mensagens do chat.

• \`!pergunta [pv] <dúvida>\`
  Faz uma pergunta para a IA sobre o histórico da conversa.

• \`!buscar [pv] <palavra>\`
  Pesquisa no histórico do SQLite.

• \`!historico [pv]\`
  Exibe o último resumo gerado sem gastar IA.

• \`!limpar\`
  Apaga o histórico do banco de dados desta conversa.`;

    await sock.sendMessage(destinationJid, { text: helpText });
  }

  // COMANDO 7: !limpar
  else if (command === 'limpar') {
    appDatabase.clearChat(remoteJid);
    await sock.sendMessage(destinationJid, { text: `🧹 Histórico de [${chatContextLabel}] apagado do banco SQLite!` });
  }

  // FALLBACK: Comando não reconhecido
  else {
    await sock.sendMessage(destinationJid, {
      text: `❓ Comando \`!${command}\` não reconhecido.\n\nDigite \`!emojis\` para ver o catálogo de superpoderes ou \`!ajuda\` para o menu principal!`,
    });
  }
}
