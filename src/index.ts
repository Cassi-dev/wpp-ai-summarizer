import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
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

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';
const ONLY_OWNER = process.env.ONLY_OWNER !== 'false'; // Padrão: apenas você pode comandar o bot
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

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
  console.log('\n🚀 Iniciando WhatsApp AI Summarizer (com SQLite Persistente)...');

  // 1. Gerenciamento de Estado da Sessão
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  // 2. Criação do Socket de Conexão com o WhatsApp Web
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '122.0.6261.129'],
    syncFullHistory: false, // Foco em mensagens em tempo real
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
      console.log('\n✅ SUCESSO: WhatsApp Conectado e Monitorando com Banco SQLite!');
      console.log(`🤖 Superpoderes ativos:`);
      console.log(`   👉 "${COMMAND_PREFIX}resumo"           - Resume as conversas recentes salvas no SQLite`);
      console.log(`   👉 "${COMMAND_PREFIX}pergunta <duvida>" - Responde perguntas sobre o chat`);
      console.log(`   👉 "${COMMAND_PREFIX}buscar <palavra>" - Pesquisa mensagens antigas no banco SQLite`);
      console.log(`   👉 "${COMMAND_PREFIX}historico"        - Exibe o último resumo gerado (sem gastar cota)`);
      console.log(`   👉 "${COMMAND_PREFIX}ouvir"            - Transcreve áudios com Gemini`);
      console.log(`   👉 Trava de segurança: ${ONLY_OWNER ? '🔒 Apenas você tem acesso' : '🌐 Aberto para todos'}\n`);
    }
  });

  // 4. Salva as credenciais sempre que forem atualizadas
  sock.ev.on('creds.update', saveCreds);

  // 5. Escuta e Processamento de Mensagens em Tempo Real (Event-Driven)
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      await handleIncomingMessage(sock, msg);
    }
  });
}

/**
 * Lida com cada mensagem recebida
 */
async function handleIncomingMessage(sock: any, msg: WAMessage) {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  // Extrai o texto da mensagem (de texto comum ou estendido)
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    '';

  const senderName = msg.pushName || 'Usuário';
  const isGroup = remoteJid.endsWith('@g.us');

  // Grava no Banco SQLite automaticamente (se for texto e não for comando)
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

  // --- TRATAMENTO DE COMANDOS ---
  const args = text.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  // COMANDO 1: !resumo [n]
  if (command === 'resumo') {
    const limit = args[1] && !isNaN(Number(args[1])) ? Math.min(Number(args[1]), 200) : 50;
    const recentMessages = appDatabase.getRecentMessages(remoteJid, limit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(remoteJid, {
        text: `⚠️ Ainda não há mensagens suficientes gravadas no SQLite para gerar um resumo (mínimo de 3 mensagens). Converse um pouco e tente de novo!`,
      });
      return;
    }

    await sock.sendMessage(remoteJid, {
      text: `⏳ _Consultando ${recentMessages.length} mensagens do banco SQLite e gerando resumo com Gemini AI..._`,
    });

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);

      // Salva o resumo no banco SQLite para consulta futura
      appDatabase.saveSummary(remoteJid, summaryResult);

      const responseMessage = formatSummaryForWhatsApp(summaryResult);
      await sock.sendMessage(remoteJid, { text: responseMessage });
    } catch (error: any) {
      console.error('Erro ao gerar resumo:', error);
      await sock.sendMessage(remoteJid, {
        text: `❌ Falha ao processar resumo: ${error.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 2: !pergunta <dúvida sobre o histórico do chat>
  else if (command === 'pergunta') {
    const question = args.slice(1).join(' ').trim();

    if (!question) {
      await sock.sendMessage(remoteJid, {
        text: `💡 *Como usar:* Digite \`${COMMAND_PREFIX}pergunta <sua dúvida>\`.\nExemplo: \`${COMMAND_PREFIX}pergunta Qual o horário da reunião?\``,
      });
      return;
    }

    const recentMessages = appDatabase.getRecentMessages(remoteJid, 100);
    if (recentMessages.length === 0) {
      await sock.sendMessage(remoteJid, {
        text: `⚠️ Nenhuma mensagem encontrada no banco SQLite desta conversa para responder sua pergunta.`,
      });
      return;
    }

    await sock.sendMessage(remoteJid, {
      text: `🔍 _Consultando histórico no SQLite para responder sua dúvida..._`,
    });

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const answer = await answerChatQuestion(formattedChat, question);

      const reply = `❓ *Pergunta:* ${question}\n\n💡 *Resposta da IA:*\n${answer}\n\n_Baseado no histórico salvo no SQLite_ 🗄️🤖`;
      await sock.sendMessage(remoteJid, { text: reply });
    } catch (error: any) {
      console.error('Erro ao responder pergunta:', error);
      await sock.sendMessage(remoteJid, {
        text: `❌ Erro ao consultar IA: ${error.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 3: !buscar <palavra> (Pesquisa rápida no banco SQLite)
  else if (command === 'buscar') {
    const query = args.slice(1).join(' ').trim();

    if (!query) {
      await sock.sendMessage(remoteJid, {
        text: `🔍 *Como usar:* Digite \`${COMMAND_PREFIX}buscar <palavra>\` para localizar mensagens antigas no banco SQLite.`,
      });
      return;
    }

    const matches = appDatabase.searchMessages(remoteJid, query, 5);

    if (matches.length === 0) {
      await sock.sendMessage(remoteJid, {
        text: `🔍 Nenhuma mensagem encontrada com o termo "${query}" no banco SQLite.`,
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

    await sock.sendMessage(remoteJid, {
      text: `🗄️ *MENSAGENS ENCONTRADAS NO SQLITE ("${query}"):*\n\n${resultados}`,
    });
  }

  // COMANDO 4: !historico (Recupera o último resumo sem gastar cota da IA)
  else if (command === 'historico') {
    const last = appDatabase.getLastSummary(remoteJid);

    if (!last) {
      await sock.sendMessage(remoteJid, {
        text: `ℹ️ Nenhum resumo anterior foi encontrado no banco de dados para esta conversa. Use \`${COMMAND_PREFIX}resumo\` primeiro!`,
      });
      return;
    }

    const dataFormatada = last.date.toLocaleString('pt-BR');
    const msg = `📑 *ÚLTIMO RESUMO ARQUIVADO* (Gerado em ${dataFormatada}):\n\n` + formatSummaryForWhatsApp(last.summary);

    await sock.sendMessage(remoteJid, { text: msg });
  }

  // COMANDO 5: !ouvir (Transcreve e resume o áudio citado)
  else if (command === 'ouvir' || command === 'audio') {
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isAudioQuote = Boolean(quotedMsg?.audioMessage);

    if (!isAudioQuote) {
      await sock.sendMessage(remoteJid, {
        text: `🎙️ *Como usar:* Responda a qualquer mensagem de áudio digitando \`${COMMAND_PREFIX}ouvir\` para transcrever e resumir o que foi dito!`,
      });
      return;
    }

    await sock.sendMessage(remoteJid, {
      text: `🎧 _Baixando áudio e enviando para o Gemini transcrever... Aguarde alguns segundos!_`,
    });

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
      const replyMessage = formatAudioSummaryForWhatsApp(audioResult);

      await sock.sendMessage(remoteJid, { text: replyMessage });
    } catch (error: any) {
      console.error('Erro ao transcrever áudio:', error);
      await sock.sendMessage(remoteJid, {
        text: `❌ Falha ao processar o áudio com IA: ${error.message || 'Erro ao decodificar áudio'}`,
      });
    }
  }

  // COMANDO 6: !ajuda
  else if (command === 'ajuda') {
    const helpText = `🤖 *WhatsApp AI Summarizer + SQLite - Comandos*

• \`${COMMAND_PREFIX}resumo [n]\`
  Gera resumo das últimas mensagens do banco SQLite (padrão: 50).

• \`${COMMAND_PREFIX}pergunta <dúvida>\`
  Responde dúvidas sobre o histórico da conversa com IA.

• \`${COMMAND_PREFIX}buscar <palavra>\`
  Pesquisa rápida no banco SQLite de mensagens anteriores.

• \`${COMMAND_PREFIX}historico\`
  Exibe o último resumo gerado sem gastar cota de IA.

• \`${COMMAND_PREFIX}ouvir\`
  Responda a um áudio com este comando para transcrever e resumir.

• \`${COMMAND_PREFIX}limpar\`
  Apaga o histórico do banco de dados desta conversa.

🗄️ *Persistência:* Banco de dados SQLite ativo com WAL mode.
🔒 *Segurança:* ${ONLY_OWNER ? 'Apenas você tem permissão.' : 'Comandos liberados para o grupo.'}`;

    await sock.sendMessage(remoteJid, { text: helpText });
  }

  // COMANDO 7: !limpar
  else if (command === 'limpar') {
    appDatabase.clearChat(remoteJid);
    await sock.sendMessage(remoteJid, { text: `🧹 Histórico desta conversa apagado do banco SQLite com sucesso!` });
  }
}

// Inicia a aplicação
startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
