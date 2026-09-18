import { WAMessage } from '@whiskeysockets/baileys';
import { appDatabase } from '../database.js';
import { parseFocusDuration } from '../utils.js';

/**
 * Intercepta mensagens 1-a-1 no privado durante sessões de Modo Foco.
 * Ativa a secretária eletrônica com trava anti-spam e permite furos de bloqueio por emergência.
 */
export async function handleFocusInterception(
  sock: any,
  msg: WAMessage,
  effectiveText: string,
  senderName: string,
  remoteJid: string,
  ownerJid: string,
  isGroup: boolean,
  watchdogKeywords: string[]
): Promise<boolean> {
  // Apenas conversas privadas 1-a-1 de terceiros são interceptadas pelo Modo Foco
  if (isGroup || msg.key.fromMe || remoteJid === ownerJid) {
    return false;
  }

  const focusSession = appDatabase.getActiveFocusSession();
  if (!focusSession) {
    return false;
  }

  const { isFirstContact } = appDatabase.recordFocusContactMessage(
    focusSession.id,
    remoteJid,
    senderName,
    effectiveText
  );

  // Se for a primeira mensagem dessa pessoa durante esta sessão, responde educadamente com a secretária eletrônica
  if (isFirstContact) {
    const untilTime = focusSession.endTime.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
    const autoReply =
      `Olá, ${senderName}! 👋\n\n` +
      `O Cassiano está em *Modo Foco / Produtividade Profunda* no momento e sem notificações ativas até às *${untilTime}*.\n\n` +
      `Sua mensagem foi registrada com segurança e ele te responderá assim que sair do foco! ⏳\n\n` +
      `_(Caso seja algo estritamente urgente, responda com a palavra *urgente*)_ 🚨`;

    await sock.sendMessage(remoteJid, { text: autoReply });
    console.log(`🔕 [Modo Foco]: Auto-resposta enviada para ${senderName} (${remoteJid})`);
  }

  // Se a pessoa enviou termo urgente no privado durante o modo foco, alerta o dono imediatamente
  const textLower = effectiveText.toLowerCase();
  if (watchdogKeywords.some((kw) => textLower.includes(kw))) {
    await sock.sendMessage(ownerJid, {
      text:
        `🚨 *URGÊNCIA NO MODO FOCO* 🚨\n\n` +
        `👤 *De:* ${senderName} (no privado)\n` +
        `💬 *Mensagem:*\n"${effectiveText.trim()}"\n\n` +
        `_Esta mensagem furou o modo foco devido ao radar de urgência!_ ⚡`,
    });
  }

  return true;
}

/**
 * Gerencia comandos de ativação, desativação e consulta do Modo Foco (!foco)
 */
export async function handleFocusCommand(
  sock: any,
  destinationJid: string,
  cleanArgs: string[]
): Promise<void> {
  const sub = cleanArgs[0]?.toLowerCase();

  if (sub === 'off' || sub === 'sair' || sub === 'cancelar' || sub === 'fim') {
    const result = appDatabase.stopFocusMode();
    if (!result.hadSession) {
      await sock.sendMessage(destinationJid, {
        text: `ℹ️ Nenhum Modo Foco estava ativo no momento.`,
      });
      return;
    }

    let report = `🔔 *MODO FOCO ENCERRADO!*\n\n⏱️ *Tempo total em foco:* ${result.durationMinutes} minutos\n\n`;
    if (result.callers.length === 0) {
      report += `🧘 *Nenhum contato te chamou no privado durante seu foco.* Produtividade máxima mantida! 🚀`;
    } else {
      report += `👥 *Contatos que tentaram falar com você no privado (${result.callers.length}):*\n\n`;
      result.callers.forEach((c, idx) => {
        report += `${idx + 1}. 👤 *${c.senderName}* (${c.count} ${c.count === 1 ? 'mensagem' : 'mensagens'}):\n   💬 "${c.lastMessage}"\n\n`;
      });
      report += `_A secretária eletrônica atendeu a todos educadamente._ ✨`;
    }

    await sock.sendMessage(destinationJid, { text: report });
  } else if (sub === 'status') {
    const active = appDatabase.getActiveFocusSession();
    if (!active) {
      await sock.sendMessage(destinationJid, {
        text: `🧘 *Modo Foco Inativo.* Notificações e mensagens normais.\n\nPara ativar, envie: \`!foco 1h\` ou \`!foco 45m\`.`,
      });
    } else {
      const until = active.endTime.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });
      const remainingMins = Math.max(0, Math.round((active.endTime.getTime() - Date.now()) / (1000 * 60)));
      await sock.sendMessage(destinationJid, {
        text: `🔕 *Modo Foco Ativo!*\n\n⏱️ Restam cerca de *${remainingMins} minutos* (até às *${until}*).\n\nPara encerrar antecipadamente, digite: \`!foco off\`.`,
      });
    }
  } else {
    const minutes = parseFocusDuration(sub);
    const session = appDatabase.startFocusMode(minutes);
    const until = session.endTime.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    const reply =
      `🔕 *MODO FOCO ATIVADO!* 🧘\n\n` +
      `⏱️ *Duração:* ${minutes} minutos (até às *${until}*)\n\n` +
      `🤖 *Secretária Eletrônica Ativa:*\n` +
      `Se alguém te enviar mensagem no privado, o bot responderá com educação avisando que você está focado até às ${until} e responderá em seguida.\n\n` +
      `🚨 *Radar de Urgência:* Caso a pessoa diga "urgente", você será alertado imediatamente!\n\n` +
      `👉 Digite \`!foco off\` a qualquer momento para desativar e ver o relatório de contatos.`;

    await sock.sendMessage(destinationJid, { text: reply });
  }
}
