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
  explainMessage,
  extractTasks,
  factCheckMessage,
  formatAudioSummaryForWhatsApp,
  formatSummaryForWhatsApp,
  generateChatSummary,
  splitExpenses,
  suggestReplies,
  summarizeLinkContent,
  transcribeAndSummarizeAudio,
  translateMessage,
} from './gemini.js';
import http from 'http';
import { ChatMessage } from './types.js';

dotenv.config();

// Servidor de Healthcheck para plataformas na nuvem (Railway, Render, Fly.io, Cloud Run)
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'online',
        service: 'WhatsApp AI Summarizer',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      })
    );
  })
  .listen(PORT, () => {
    console.log(`🌐 Servidor HTTP de Healthcheck ativo na porta ${PORT}`);
  });

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
  console.log('\n🚀 Iniciando WhatsApp AI Summarizer (com Suíte Completa de Reações)...');

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
      console.log('\n✅ SUCESSO: WhatsApp Conectado com Suíte Completa de Emojis!');
      console.log(`🤖 Emojis Invisíveis Ativos no Privado:`);
      console.log(`   👉 🧠 (Resumir)  | ✍️ (Ghostwriter) | 💡 (Explicar) | 📌 (Salvar) | 🌐 (Traduzir)`);
      console.log(`   👉 🎯 (Tarefas)  | 🕵️ (Fact-Check)  | 💰 (Rachid)   | 🔗 (Resumir Link) | 🎧 (Áudio)`);
      console.log(`   👉 Digite "!emojis" no seu WhatsApp para ver o manual completo!\n`);
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
  // 1. DISPATCHER DE REAÇÕES INVISÍVEIS POR EMOJI
  // =========================================================================
  const reaction = msg.message?.reactionMessage;
  if (reaction && reaction.text) {
    if (!isAuthorized(msg)) return;
    await handleReactionTrigger(sock, msg, reaction, ownerJid);
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

  // Decide se a resposta deve ser enviada para o seu privado pessoal
  const shouldSendPrivate =
    !isAlreadyPrivateChat &&
    (explicitlyPrivate || (isGroup && ALWAYS_PRIVATE && !explicitlyGroup));

  const destinationJid = shouldSendPrivate ? ownerJid : remoteJid;

  // Argumentos limpos
  const cleanArgs = allArgs.slice(1).filter((a) => !['pv', 'privado', 'segredo', 'grupo', 'publico'].includes(a.toLowerCase()));
  const chatContextLabel = isGroup ? '👥 Grupo' : `👤 Conversa com ${senderName}`;

  console.log(`\n🤖 Comando [${command}] disparado no chat: ${remoteJid}`);
  console.log(`   Destino da resposta: ${destinationJid} (Modo Privado: ${shouldSendPrivate})`);

  // COMANDO: !emojis ou !emoji ou !superpoderes ou !menu (MANUAL COMPLETO DAS REAÇÕES)
  if (command === 'emojis' || command === 'emoji' || command === 'superpoderes' || command === 'menu') {
    const guide = `🎛️ *CATÁLOGO DE SUPERPODERES INVISÍVEIS (REAÇÕES)* 🤫

Reaja com qualquer um destes emojis em qualquer mensagem de qualquer chat para ativar a IA em silêncio absoluto (a resposta chega somente no seu privado!):

🧠 *[Cérebro]* ➔ *Resumo Completo:*
Lê as últimas 50 mensagens daquele chat e gera um resumo executivo com tópicos, decisões e urgência.

✍️ *[Caneta]* ➔ *Ghostwriter de Respostas:*
Gera 3 opções elegantes de resposta para você enviar de volta (Profissional, Amigável ou Direta).

💡 *[Lâmpada]* ➔ *Explicador Didático:*
Explica um termo técnico, texto longo ou assunto confuso em linguagem simples.

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
💡 _Dica: No chat onde você reage, nada é enviado nem apagado. Ninguém vê nada além da sua reação!_`;

    await sock.sendMessage(destinationJid, { text: guide });
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

  // COMANDO 1: !resumo [n] [pv]
  else if (command === 'resumo') {
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

  // COMANDO 5: !ouvir [pv]
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

  // COMANDO 6: !ajuda ou !help
  else if (command === 'ajuda' || command === 'help') {
    const helpText = `🤖 *WhatsApp AI Summarizer - Menu Principal*

• \`!emojis\` ou \`!superpoderes\`
  Exibe o catálogo completo de reações por emojis invisíveis!

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

/**
 * Processador dedicado para todas as Reações com Emojis (Gatilhos Invisíveis)
 */
async function handleReactionTrigger(sock: any, msg: WAMessage, reaction: any, ownerJid: string) {
  const emoji = reaction.text?.trim();
  const targetChatJid = reaction.key?.remoteJid;
  const targetMsgId = reaction.key?.id;

  if (!targetChatJid) return;

  const isGrp = targetChatJid.endsWith('@g.us');
  const chatTitle = isGrp ? 'Grupo' : 'Conversa Privada';

  // 1. EMOJI 🧠: RESUMO DO CHAT
  if (emoji === '🧠') {
    console.log(`\n🧠 [Gatilho 🧠]: Resumindo chat ${targetChatJid}...`);
    const recentMessages = appDatabase.getRecentMessages(targetChatJid, 50);

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
    }
    return;
  }

  // 2. BUSCA A MENSAGEM ALVO NO BANCO DE DADOS
  const targetMsg = appDatabase.getMessageById(targetMsgId || '');

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

// Inicia a aplicação
startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
