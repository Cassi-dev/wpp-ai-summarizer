import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  WAMessage,
} from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { messageBuffer } from './buffer.js';
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
  console.log('\n🚀 Iniciando WhatsApp AI Summarizer...');

  // 1. Gerenciamento de Estado da Sessão (salva as credenciais em disco para não pedir QR code toda vez)
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  // 2. Criação do Socket de Conexão com o WhatsApp Web
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '122.0.6261.129'],
    syncFullHistory: false, // Foco em mensagens em tempo real, sem puxar anos de histórico
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
      console.log('\n✅ SUCESSO: WhatsApp Conectado e Monitorando Mensagens!');
      console.log(`🤖 Superpoderes ativos:`);
      console.log(`   👉 "${COMMAND_PREFIX}resumo"           - Resume as conversas recentes`);
      console.log(`   👉 "${COMMAND_PREFIX}pergunta <duvida>" - Responde perguntas sobre o chat`);
      console.log(`   👉 "${COMMAND_PREFIX}ouvir"            - Transcreve áudio (responda a um áudio)`);
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

  // Armazena no buffer (apenas se for texto e não for um comando do bot)
  if (text && !text.startsWith(COMMAND_PREFIX)) {
    const chatMsg: ChatMessage = {
      id: msg.key.id || Math.random().toString(),
      sender: msg.key.participant || remoteJid,
      senderName,
      text: text.trim(),
      timestamp: new Date((msg.messageTimestamp as number) * 1000),
      isGroup,
    };
    messageBuffer.addMessage(remoteJid, chatMsg);
    return;
  }

  // Se a mensagem não tem comando de texto, encerra
  if (!text.startsWith(COMMAND_PREFIX)) return;

  // --- TRAVA DE SEGURANÇA (Verifica se quem chamou o comando está autorizado) ---
  if (!isAuthorized(msg)) {
    console.log(`🚫 Comando bloqueado para usuário não autorizado: ${senderName} (${remoteJid})`);
    return; // Ignora silenciosamente para não gastar API nem poluir o chat
  }

  // --- TRATAMENTO DE COMANDOS ---
  const args = text.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  // COMANDO 1: !resumo [n]
  if (command === 'resumo') {
    const limit = args[1] && !isNaN(Number(args[1])) ? Math.min(Number(args[1]), 100) : 50;
    const recentMessages = messageBuffer.getRecentMessages(remoteJid, limit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(remoteJid, {
        text: `⚠️ Ainda não acumulei mensagens suficientes nesta conversa para gerar um resumo (mínimo de 3 mensagens necessárias). Converse mais um pouco e tente de novo!`,
      });
      return;
    }

    await sock.sendMessage(remoteJid, {
      text: `⏳ _Lendo as últimas ${recentMessages.length} mensagens e gerando resumo inteligente com Gemini AI..._`,
    });

    try {
      const formattedChat = messageBuffer.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);
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

    const recentMessages = messageBuffer.getRecentMessages(remoteJid, 50);
    if (recentMessages.length === 0) {
      await sock.sendMessage(remoteJid, {
        text: `⚠️ Nenhuma mensagem recente em memória nesta conversa para responder sua pergunta.`,
      });
      return;
    }

    await sock.sendMessage(remoteJid, {
      text: `🔍 _Consultando o histórico de mensagens para responder à sua dúvida..._`,
    });

    try {
      const formattedChat = messageBuffer.formatForAI(recentMessages);
      const answer = await answerChatQuestion(formattedChat, question);

      const reply = `❓ *Pergunta:* ${question}\n\n💡 *Resposta da IA:*\n${answer}\n\n_Baseado nas mensagens recentes desta conversa_ 🤖`;
      await sock.sendMessage(remoteJid, { text: reply });
    } catch (error: any) {
      console.error('Erro ao responder pergunta:', error);
      await sock.sendMessage(remoteJid, {
        text: `❌ Erro ao consultar IA: ${error.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 3: !ouvir (Transcreve e resume o áudio citado)
  else if (command === 'ouvir' || command === 'audio') {
    // Verifica se o comando foi enviado como resposta (quote) a um áudio
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isAudioQuote = Boolean(quotedMsg?.audioMessage);

    if (!isAudioQuote) {
      await sock.sendMessage(remoteJid, {
        text: `🎙️ *Como usar:* Responda a qualquer mensagem de áudio digitando \`${COMMAND_PREFIX}ouvir\` para transcrever e resumir o que foi dito sem precisar escutar!`,
      });
      return;
    }

    await sock.sendMessage(remoteJid, {
      text: `🎧 _Baixando áudio e enviando para o Gemini transcrever... Aguarde alguns segundos!_`,
    });

    try {
      // Baixa o buffer binário do áudio citado
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

  // COMANDO 4: !ajuda
  else if (command === 'ajuda') {
    const helpText = `🤖 *WhatsApp AI Summarizer - Comandos Disponíveis*

• \`${COMMAND_PREFIX}resumo [n]\`
  Gera resumo com tópicos, decisões, pendências e grau de urgência (padrão: 50 mensagens).

• \`${COMMAND_PREFIX}pergunta <dúvida>\`
  Faz uma pergunta pontual para a IA sobre o que conversaram recentemente.

• \`${COMMAND_PREFIX}ouvir\`
  Responda a qualquer áudio com este comando para receber a transcrição e resumo do áudio!

• \`${COMMAND_PREFIX}limpar\`
  Esvazia a memória temporária de mensagens desta conversa.

🔒 *Segurança:* ${ONLY_OWNER ? 'Apenas o dono da conta tem permissão para disparar comandos.' : 'Comandos abertos para o grupo.'}`;

    await sock.sendMessage(remoteJid, { text: helpText });
  }

  // COMANDO 5: !limpar
  else if (command === 'limpar') {
    messageBuffer.clear(remoteJid);
    await sock.sendMessage(remoteJid, { text: `🧹 Memória temporária desta conversa limpa com sucesso!` });
  }
}

// Inicia a aplicação
startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
