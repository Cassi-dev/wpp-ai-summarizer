import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  useMultiFileAuthState,
  WAMessage,
} from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { appDatabase } from './database.js';
import {
  answerChatQuestion,
  formatAudioSummaryForWhatsApp,
  formatSummaryForWhatsApp,
  generateChatSummary,
  transcribeAndSummarizeAudio,
} from './gemini.js';
import { ChatMessage } from './types.js';

dotenv.config();

// ESCUDO CONTRA QUEDAS: Evita que erros temporários de criptografia (Signal) derrubem o processo
process.on('uncaughtException', (err: any) => {
  if (
    err?.message?.includes('Key used already') ||
    err?.message?.includes('Session error') ||
    err?.message?.includes('decrypt')
  ) {
    return;
  }
  console.error('⚠️ Aviso do sistema (ignorado para não derrubar o bot):', err.message);
});

process.on('unhandledRejection', (reason: any) => {
  if (
    reason?.message?.includes('Key used already') ||
    reason?.message?.includes('Session error') ||
    reason?.message?.includes('decrypt')
  ) {
    return;
  }
  console.error('⚠️ Aviso assíncrono (ignorado para não derrubar o bot):', reason?.message || reason);
});

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';
const ONLY_OWNER = process.env.ONLY_OWNER !== 'false'; // Padrão: apenas você pode comandar o bot
const ALWAYS_PRIVATE = process.env.ALWAYS_PRIVATE === 'true'; // Se true, sempre manda no privado quando em grupos
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

/**
 * Obtém o JID do WhatsApp privado do usuário (dono da conta)
 */
function getOwnerJid(sock: any, msg: WAMessage): string {
  if (sock.user?.id) {
    return jidNormalizedUser(sock.user.id);
  }
  if (msg.key.participant) {
    return jidNormalizedUser(msg.key.participant);
  }
  return jidNormalizedUser(msg.key.remoteJid || '');
}

/**
 * Verifica se quem enviou o comando tem permissão de execução
 */
function isAuthorized(msg: WAMessage): boolean {
  if (msg.key.fromMe) return true; // Sempre autoriza você (dono da conta)
  if (!ONLY_OWNER) return true; // Se desativou a trava, permite qualquer um

  const sender = msg.key.participant || msg.key.remoteJid || '';
  const senderNumber = sender.replace(/[^0-9]/g, '');

  return ALLOWED_NUMBERS.some((num) => senderNumber.includes(num));
}

/**
 * Função principal que inicia o cliente WhatsApp e escuta os eventos
 */
async function startWhatsAppBot() {
  console.log('\n🚀 Iniciando WhatsApp AI Summarizer (com Modo Fantasma Invisível 🧠)...');

  // 1. Gerenciamento de Estado da Sessão
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  // 2. Criação do Socket de Conexão com o WhatsApp Web
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '122.0.6261.129'],
    syncFullHistory: false, // Foco em mensagens em tempo real
    getMessage: async (key) => {
      const m = appDatabase.getMessageById(key.id || '');
      if (m) {
        return { conversation: m.text };
      }
      return undefined;
    },
  });

  // 3. Monitoramento do Status da Conexão e Exibição do QR Code
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=============================================================');
      console.log('📱 ESCANEIE O QR CODE ABAIXO COM O SEU WHATSAPP NO CELULAR:');
      console.log('   (WhatsApp > Menu de 3 pontos ou Configurações > Aparelhos Conectados)');
      console.log('=============================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.log('❌ Sessão desconectada pelo celular. Execute novamente para escanear novo QR Code.');
      } else {
        console.log(`⚠️ Conexão oscilou (código: ${statusCode || 'desconhecido'}). Reconectando em 3s...`);
        setTimeout(() => {
          startWhatsAppBot();
        }, 3000);
      }
    } else if (connection === 'open') {
      console.log('\n✅ SUCESSO: WhatsApp Conectado com SQLite e Modo Fantasma!');
      console.log(`🤖 Superpoderes ativos:`);
      console.log(`   👉 🧠 Reação com Emoji - Reaja com 🧠 em qualquer mensagem e receba o resumo no privado!`);
      console.log(`   👉 "${COMMAND_PREFIX}resumo"           - Responde no próprio chat`);
      console.log(`   👉 "${COMMAND_PREFIX}resumo pv"        - Envia no seu PRIVADO sem avisos`);
      console.log(`   👉 "${COMMAND_PREFIX}pergunta pv <dúvida>" - Responde pergunta no privado`);
      console.log(`   👉 "${COMMAND_PREFIX}ouvir pv"         - Transcreve áudio no privado`);
      console.log(`   👉 "${COMMAND_PREFIX}buscar [pv] <palavra>" - Pesquisa mensagens no SQLite\n`);
    }
  });

  // 4. Salva as credenciais sempre que forem atualizadas
  sock.ev.on('creds.update', saveCreds);

  // 5. Escuta e Processamento de Mensagens em Tempo Real (Event-Driven)
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      try {
        await handleIncomingMessage(sock, msg);
      } catch (err: any) {
        console.error('⚠️ Erro ao processar mensagem (bot segue vivo):', err.message);
      }
    }
  });
}

/**
 * Lida com cada mensagem recebida
 */
async function handleIncomingMessage(sock: any, msg: WAMessage) {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const ownerJid = getOwnerJid(sock, msg);

  // =========================================================================
  // 1. GATILHO INVISÍVEL: REAÇÃO COM O EMOJI 🧠
  // =========================================================================
  const reaction = msg.message?.reactionMessage;
  if (reaction && reaction.text === '🧠') {
    if (!isAuthorized(msg)) return;

    const targetChatJid = reaction.key?.remoteJid;
    if (!targetChatJid) return;

    const isGrp = targetChatJid.endsWith('@g.us');
    const chatTitle = isGrp ? 'Grupo' : 'Conversa';

    console.log(`\n🧠 [Gatilho Invisível]: Reação com emoji 🧠 detectada no chat: ${targetChatJid}`);

    const recentMessages = appDatabase.getRecentMessages(targetChatJid, 50);
    if (recentMessages.length < 3) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ [${chatTitle}] Poucas mensagens registradas no SQLite para gerar um resumo (mínimo de 3 mensagens).`,
      });
      return;
    }

    console.log(`📤 Enviando resumo silencioso diretamente para seu privado: ${ownerJid}`);

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);
      appDatabase.saveSummary(targetChatJid, summaryResult);

      const responseMessage =
        `👻 *[MODO FANTASMA INVISÍVEL 🧠]*\n📋 *Resumo de: ${chatTitle}*\n\n` +
        formatSummaryForWhatsApp(summaryResult);

      await sock.sendMessage(ownerJid, { text: responseMessage });
      console.log(`✅ Resumo entregue com sucesso no seu privado!`);
    } catch (err: any) {
      console.error('Erro ao gerar resumo por reação:', err);
      await sock.sendMessage(ownerJid, {
        text: `❌ Falha ao processar resumo por reação: ${err.message}`,
      });
    }
    return;
  }

  // =========================================================================
  // 2. MENSAGENS DE TEXTO E GRAVAÇÃO NO SQLITE
  // =========================================================================
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    '';

  const senderName = msg.pushName || 'Usuário';
  const isGroup = remoteJid.endsWith('@g.us');

  // Grava no Banco SQLite automaticamente (se for texto comum e não for comando)
  if (text && !text.startsWith(COMMAND_PREFIX)) {
    const chatMsg: ChatMessage = {
      id: msg.key.id || Math.random().toString(),
      sender: msg.key.participant || remoteJid,
      senderName,
      text: text.trim(),
      timestamp: new Date((msg.messageTimestamp as number) * 1000),
      isGroup,
    };
    appDatabase.saveMessage(remoteJid, chatMsg);
    return;
  }

  // Se a mensagem não tem comando de texto, encerra
  if (!text.startsWith(COMMAND_PREFIX)) return;

  // --- TRAVA DE SEGURANÇA ---
  if (!isAuthorized(msg)) {
    console.log(`🚫 Comando bloqueado para usuário não autorizado: ${senderName} (${remoteJid})`);
    return;
  }

  // --- TRATAMENTO DE COMANDOS E MODOS DE VISIBILIDADE ---
  const allArgs = text.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = allArgs[0]?.toLowerCase();

  // Flags de privacidade
  const lowerArgs = allArgs.map((a) => a.toLowerCase());
  const explicitlyPrivate = lowerArgs.includes('pv') || lowerArgs.includes('privado') || lowerArgs.includes('segredo');
  const explicitlyGroup = lowerArgs.includes('grupo') || lowerArgs.includes('publico');

  const isAlreadyPrivateChat = remoteJid === ownerJid;

  // Decide se a resposta deve ser desviada para o seu privado pessoal
  const shouldSendPrivate =
    !isAlreadyPrivateChat &&
    (explicitlyPrivate || (isGroup && ALWAYS_PRIVATE && !explicitlyGroup));

  // O destino real da resposta: se privado, manda EXCLUSIVAMENTE para você
  const destinationJid = shouldSendPrivate ? ownerJid : remoteJid;

  // Argumentos limpos
  const cleanArgs = allArgs.slice(1).filter((a) => !['pv', 'privado', 'segredo', 'grupo', 'publico'].includes(a.toLowerCase()));

  // Identificador do chat para você saber de onde veio o resumo
  const chatContextLabel = isGroup ? '👥 Grupo' : `👤 Conversa com ${senderName}`;

  console.log(`\n🤖 Comando [${command}] disparado no chat: ${remoteJid}`);
  console.log(`   Destino da resposta: ${destinationJid} (Modo Privado: ${shouldSendPrivate})`);

  // COMANDO 1: !resumo [n] [pv]
  if (command === 'resumo') {
    const limit = cleanArgs[0] && !isNaN(Number(cleanArgs[0])) ? Math.min(Number(cleanArgs[0]), 200) : 50;
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

      // Salva o resumo no banco SQLite
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
        text: `❌ Falha ao processar resumo: ${error.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 2: !pergunta [pv] <dúvida sobre o histórico do chat>
  else if (command === 'pergunta') {
    const question = cleanArgs.join(' ').trim();

    if (!question) {
      await sock.sendMessage(destinationJid, {
        text: `💡 *Como usar:* Digite \`${COMMAND_PREFIX}pergunta <sua dúvida>\` (adicione \`pv\` para receber no privado).\nExemplo: \`${COMMAND_PREFIX}pergunta pv Qual o horário da reunião?\``,
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
        text: `❌ Erro ao consultar IA: ${error.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 3: !buscar [pv] <palavra>
  else if (command === 'buscar') {
    const query = cleanArgs.join(' ').trim();

    if (!query) {
      await sock.sendMessage(destinationJid, {
        text: `🔍 *Como usar:* Digite \`${COMMAND_PREFIX}buscar <palavra>\` (adicione \`pv\` para receber no privado).`,
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
        text: `ℹ️ Nenhum resumo anterior foi encontrado no banco de dados para [${chatContextLabel}]. Use \`${COMMAND_PREFIX}resumo\` primeiro!`,
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

  // COMANDO 5: !ouvir [pv] (Transcreve e resume o áudio citado)
  else if (command === 'ouvir' || command === 'audio') {
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isAudioQuote = Boolean(quotedMsg?.audioMessage);

    if (!isAudioQuote) {
      await sock.sendMessage(destinationJid, {
        text: `🎙️ *Como usar:* Responda a qualquer mensagem de áudio digitando \`${COMMAND_PREFIX}ouvir\` (ou \`${COMMAND_PREFIX}ouvir pv\` para receber no privado)!`,
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

  // COMANDO 6: !ajuda
  else if (command === 'ajuda') {
    const helpText = `🤖 *WhatsApp AI Summarizer - Comandos & Gatilhos*

• 🧠 *Gatilho Invisível (Reação):*
  Reaja com o emoji 🧠 a qualquer mensagem de qualquer chat para receber o resumo no seu privado em silêncio absoluto!

• \`${COMMAND_PREFIX}resumo [n]\`
  Gera resumo e responde no próprio chat.

• \`${COMMAND_PREFIX}resumo pv [n]\`
  Gera resumo e envia apenas no seu privado.

• \`${COMMAND_PREFIX}pergunta [pv] <dúvida>\`
  Responde dúvidas sobre o histórico.

• \`${COMMAND_PREFIX}buscar [pv] <palavra>\`
  Pesquisa mensagens antigas no SQLite.

• \`${COMMAND_PREFIX}ouvir [pv]\`
  Responda a um áudio para transcrever.

• \`${COMMAND_PREFIX}historico [pv]\`
  Recupera o último resumo sem gastar IA.

• \`${COMMAND_PREFIX}limpar\`
  Apaga o histórico do banco de dados desta conversa.`;

    await sock.sendMessage(destinationJid, { text: helpText });
  }

  // COMANDO 7: !limpar
  else if (command === 'limpar') {
    appDatabase.clearChat(remoteJid);
    await sock.sendMessage(destinationJid, { text: `🧹 Histórico de [${chatContextLabel}] apagado do banco SQLite!` });
  }
}

// Inicia a aplicação
startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
