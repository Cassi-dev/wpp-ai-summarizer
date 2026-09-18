import { describe, expect, it } from 'vitest';
import { appDatabase } from '../src/database.js';
import { ChatMessage } from '../src/types.js';

describe('Database Engine - SQLite CRUD e Regras de Negócio', () => {
  const testChatJid = 'test_suite_group@g.us';

  it('deve salvar e recuperar mensagens ordenadas por data', () => {
    const msg1: ChatMessage = {
      id: 'msg_test_1',
      sender: 'user_1@s.whatsapp.net',
      senderName: 'Cassiano',
      text: 'Primeira mensagem de teste do Vitest',
      timestamp: new Date(Date.now() - 5000),
      isGroup: true,
    };

    const msg2: ChatMessage = {
      id: 'msg_test_2',
      sender: 'user_2@s.whatsapp.net',
      senderName: 'Mariana',
      text: 'Segunda mensagem de teste do Vitest',
      timestamp: new Date(Date.now()),
      isGroup: true,
    };

    appDatabase.saveMessage(testChatJid, msg1);
    appDatabase.saveMessage(testChatJid, msg2);

    const recent = appDatabase.getRecentMessages(testChatJid, 10);
    expect(recent.length).toBeGreaterThanOrEqual(2);

    const found1 = recent.find((m) => m.id === 'msg_test_1');
    const found2 = recent.find((m) => m.id === 'msg_test_2');

    expect(found1).toBeDefined();
    expect(found1?.text).toBe('Primeira mensagem de teste do Vitest');
    expect(found2).toBeDefined();
    expect(found2?.text).toBe('Segunda mensagem de teste do Vitest');
  });

  it('deve buscar mensagens por termo no histórico (Full-text search básico)', () => {
    const results = appDatabase.searchMessages(testChatJid, 'Vitest', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text).toContain('Vitest');
  });

  it('deve fixar e listar notas e favoritos (📌)', () => {
    appDatabase.savePinnedNote(
      'note_test_1',
      testChatJid,
      'Grupo de Testes',
      'Cassiano',
      'Anotação super importante para teste'
    );

    const pinned = appDatabase.getPinnedNotes(5);
    const foundNote = pinned.find((n) => n.text === 'Anotação super importante para teste');

    expect(foundNote).toBeDefined();
    expect(foundNote?.senderName).toBe('Cassiano');
    expect(foundNote?.chatTitle).toBe('Grupo de Testes');
  });

  it('deve gerenciar sessões do Modo Foco com filtro anti-spam (isFirstContact)', () => {
    // 1. Inicia sessão de foco
    const session = appDatabase.startFocusMode(30);
    expect(session.sessionId).toBeGreaterThan(0);
    expect(session.endTime.getTime()).toBeGreaterThan(Date.now());

    // 2. Verifica se a sessão está ativa
    const active = appDatabase.getActiveFocusSession();
    expect(active).not.toBeNull();
    expect(active?.id).toBe(session.sessionId);

    // 3. Primeira mensagem do contato (deve ser isFirstContact: true)
    const firstCall = appDatabase.recordFocusContactMessage(
      session.sessionId,
      '5511988887777@s.whatsapp.net',
      'Cliente Importante',
      'Olá, você pode me atender agora?'
    );
    expect(firstCall.isFirstContact).toBe(true);

    // 4. Segunda mensagem do mesmo contato (deve ser isFirstContact: false - anti-spam)
    const secondCall = appDatabase.recordFocusContactMessage(
      session.sessionId,
      '5511988887777@s.whatsapp.net',
      'Cliente Importante',
      'É sobre a proposta!'
    );
    expect(secondCall.isFirstContact).toBe(false);

    // 5. Encerra o modo foco e obtém relatório
    const stopResult = appDatabase.stopFocusMode();
    expect(stopResult.hadSession).toBe(true);
    expect(stopResult.callers.length).toBe(1);
    expect(stopResult.callers[0].senderName).toBe('Cliente Importante');
    expect(stopResult.callers[0].count).toBe(2);

    // 6. Confirma que a sessão foi inativada
    const afterStop = appDatabase.getActiveFocusSession();
    expect(afterStop).toBeNull();
  });

  it('deve limpar o histórico do chat de teste', () => {
    appDatabase.clearChat(testChatJid);
    const afterClear = appDatabase.getRecentMessages(testChatJid, 10);
    expect(afterClear.length).toBe(0);
  });
});
