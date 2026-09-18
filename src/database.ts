import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { ChatMessage, SummaryResult } from './types.js';

/**
 * Gerenciador do Banco de Dados SQLite Local.
 * Todas as mensagens e resumos são gravados de forma persistente e com índice rápido.
 */
class SQLiteDatabaseManager {
  private db: DatabaseType;

  constructor() {
    const dbPath = path.resolve('database.sqlite');
    this.db = new Database(dbPath);

    // Habilita o modo WAL (Write-Ahead Logging) para máxima velocidade de escrita e concorrência
    this.db.pragma('journal_mode = WAL');

    this.initTables();
  }

  /**
   * Cria as tabelas do banco de dados caso não existam
   */
  private initTables(): void {
    // Tabela de Mensagens
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_group INTEGER NOT NULL,
        raw_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_time 
      ON messages (remote_jid, timestamp DESC);

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_jid TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        urgency TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_chat_time 
      ON summaries (remote_jid, timestamp DESC);

      CREATE TABLE IF NOT EXISTS pinned_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pinned_notes_time 
      ON pinned_notes (timestamp DESC);

      CREATE TABLE IF NOT EXISTS focus_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        active INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS focus_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);

    // Migração suave: Adiciona raw_message caso a tabela já exista em bancos prévios
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN raw_message TEXT;');
    } catch {}
  }

  /**
   * Salva uma mensagem no banco de dados SQLite
   */
  public saveMessage(remoteJid: string, message: ChatMessage): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, remote_jid, sender, sender_name, text, timestamp, is_group, raw_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      remoteJid,
      message.sender,
      message.senderName,
      message.text,
      message.timestamp.getTime(),
      message.isGroup ? 1 : 0,
      message.rawMessage || null
    );
  }

  /**
   * Busca as últimas N mensagens de uma conversa específica
   */
  public getRecentMessages(remoteJid: string, limit: number = 50): ChatMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT id, sender, sender_name as senderName, text, timestamp, is_group as isGroup
        FROM messages
        WHERE remote_jid = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(remoteJid, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      sender: r.sender,
      senderName: r.senderName,
      text: r.text,
      timestamp: new Date(r.timestamp),
      isGroup: Boolean(r.isGroup),
    }));
  }

  /**
   * Busca uma mensagem pelo ID específico (necessário para resincronização de chaves do Baileys)
   */
  public getMessageById(id: string): ChatMessage | null {
    const stmt = this.db.prepare(`
      SELECT id, sender, sender_name as senderName, text, timestamp, is_group as isGroup, raw_message as rawMessage
      FROM messages
      WHERE id = ?
    `);

    const r = stmt.get(id) as any;
    if (!r) return null;

    return {
      id: r.id,
      sender: r.sender,
      senderName: r.senderName,
      text: r.text,
      timestamp: new Date(r.timestamp),
      isGroup: Boolean(r.isGroup),
      rawMessage: r.rawMessage,
    };
  }

  /**
   * Pesquisa mensagens que contenham um termo específico no histórico
   */
  public searchMessages(remoteJid: string, query: string, limit: number = 10): ChatMessage[] {
    const stmt = this.db.prepare(`
      SELECT id, sender, sender_name as senderName, text, timestamp, is_group as isGroup
      FROM messages
      WHERE remote_jid = ? AND text LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(remoteJid, `%${query}%`, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      sender: r.sender,
      senderName: r.senderName,
      text: r.text,
      timestamp: new Date(r.timestamp),
      isGroup: Boolean(r.isGroup),
    }));
  }

  /**
   * Salva um resumo estruturado no banco de dados
   */
  public saveSummary(remoteJid: string, summary: SummaryResult): void {
    const stmt = this.db.prepare(`
      INSERT INTO summaries (remote_jid, summary_json, urgency, timestamp)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(remoteJid, JSON.stringify(summary), summary.urgencia, Date.now());
  }

  /**
   * Obtém o último resumo gerado para esta conversa
   */
  public getLastSummary(remoteJid: string): { summary: SummaryResult; date: Date } | null {
    const stmt = this.db.prepare(`
      SELECT summary_json, timestamp FROM summaries
      WHERE remote_jid = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = stmt.get(remoteJid) as any;
    if (!row) return null;

    return {
      summary: JSON.parse(row.summary_json),
      date: new Date(row.timestamp),
    };
  }

  /**
   * Limpa o histórico de uma conversa no banco de dados
   */
  public clearChat(remoteJid: string): void {
    this.db.prepare('DELETE FROM messages WHERE remote_jid = ?').run(remoteJid);
    this.db.prepare('DELETE FROM summaries WHERE remote_jid = ?').run(remoteJid);
  }

  /**
   * Salva uma mensagem como Nota Fixada/Favorito no SQLite
   */
  public savePinnedNote(
    messageId: string,
    chatJid: string,
    chatTitle: string,
    senderName: string,
    text: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO pinned_notes (message_id, chat_jid, chat_title, sender_name, text, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(messageId, chatJid, chatTitle, senderName, text, Date.now());
  }

  /**
   * Retorna as notas fixadas salvas pelo usuário
   */
  public getPinnedNotes(limit: number = 20): Array<{
    id: number;
    chatTitle: string;
    senderName: string;
    text: string;
    date: Date;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, chat_title as chatTitle, sender_name as senderName, text, timestamp
      FROM pinned_notes
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      chatTitle: r.chatTitle,
      senderName: r.senderName,
      text: r.text,
      date: new Date(r.timestamp),
    }));
  }

  /**
   * Apaga todas as notas fixadas
   */
  public clearPinnedNotes(): void {
    this.db.prepare('DELETE FROM pinned_notes').run();
  }

  /**
   * Retorna os chats que tiveram movimentação a partir de um determinado timestamp
   */
  public getActiveChatsSince(sinceTimestamp: number, minMessages: number = 3): Array<{
    remoteJid: string;
    messageCount: number;
    isGroup: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT remote_jid as remoteJid, COUNT(*) as messageCount, MAX(is_group) as isGroup
      FROM messages
      WHERE timestamp >= ?
      GROUP BY remote_jid
      HAVING COUNT(*) >= ?
      ORDER BY messageCount DESC
    `);

    const rows = stmt.all(sinceTimestamp, minMessages) as any[];
    return rows.map((r) => ({
      remoteJid: r.remoteJid,
      messageCount: r.messageCount,
      isGroup: Boolean(r.isGroup),
    }));
  }

  /**
   * Busca mensagens de um chat enviadas a partir de um timestamp
   */
  public getMessagesSince(remoteJid: string, sinceTimestamp: number, limit: number = 100): ChatMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT id, sender, sender_name as senderName, text, timestamp, is_group as isGroup
        FROM messages
        WHERE remote_jid = ? AND timestamp >= ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(remoteJid, sinceTimestamp, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      sender: r.sender,
      senderName: r.senderName,
      text: r.text,
      timestamp: new Date(r.timestamp),
      isGroup: Boolean(r.isGroup),
    }));
  }

  /**
   * Formata mensagens para a entrada de texto do Gemini
   */
  public formatForAI(messages: ChatMessage[]): string {
    if (messages.length === 0) return 'Nenhuma mensagem recente encontrada.';

    return messages
      .map((m) => {
        const hora = m.timestamp.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        return `[${hora}] ${m.senderName}: ${m.text}`;
      })
      .join('\n');
  }

  /**
   * Inicia uma sessão de Modo Foco
   */
  public startFocusMode(durationMinutes: number): { sessionId: number; endTime: Date } {
    const startTime = Date.now();
    const endTime = startTime + durationMinutes * 60 * 1000;

    this.db.prepare('UPDATE focus_sessions SET active = 0 WHERE active = 1').run();

    const stmt = this.db.prepare(`
      INSERT INTO focus_sessions (start_time, end_time, active)
      VALUES (?, ?, 1)
    `);

    const result = stmt.run(startTime, endTime);
    return {
      sessionId: Number(result.lastInsertRowid),
      endTime: new Date(endTime),
    };
  }

  /**
   * Encerra o Modo Foco e retorna os contatos que tentaram falar com você
   */
  public stopFocusMode(): {
    hadSession: boolean;
    durationMinutes: number;
    callers: Array<{ senderName: string; count: number; lastMessage: string }>;
  } {
    const active = this.getActiveFocusSession();
    if (!active) {
      return { hadSession: false, durationMinutes: 0, callers: [] };
    }

    const sessionData = this.db.prepare('SELECT start_time FROM focus_sessions WHERE id = ?').get(active.id) as any;
    const durationMinutes = Math.max(1, Math.round((Date.now() - sessionData.start_time) / (1000 * 60)));

    this.db.prepare('UPDATE focus_sessions SET active = 0 WHERE id = ?').run(active.id);

    const stmt = this.db.prepare(`
      SELECT sender_name as senderName, COUNT(*) as count, MAX(text) as lastMessage
      FROM focus_messages
      WHERE session_id = ?
      GROUP BY sender_jid
      ORDER BY count DESC
    `);

    const callers = stmt.all(active.id) as any[];

    return {
      hadSession: true,
      durationMinutes,
      callers,
    };
  }

  /**
   * Verifica se há uma sessão de Modo Foco ativa no momento
   */
  public getActiveFocusSession(): { id: number; endTime: Date } | null {
    const stmt = this.db.prepare(`
      SELECT id, end_time as endTime
      FROM focus_sessions
      WHERE active = 1
      ORDER BY id DESC
      LIMIT 1
    `);

    const row = stmt.get() as any;
    if (!row) return null;

    if (Date.now() > row.endTime) {
      this.db.prepare('UPDATE focus_sessions SET active = 0 WHERE id = ?').run(row.id);
      return null;
    }

    return {
      id: row.id,
      endTime: new Date(row.endTime),
    };
  }

  /**
   * Registra uma mensagem recebida durante o Modo Foco
   */
  public recordFocusContactMessage(
    sessionId: number,
    senderJid: string,
    senderName: string,
    text: string
  ): { isFirstContact: boolean } {
    const checkStmt = this.db.prepare(`
      SELECT COUNT(*) as c FROM focus_messages WHERE session_id = ? AND sender_jid = ?
    `);
    const count = (checkStmt.get(sessionId, senderJid) as any).c;

    const insertStmt = this.db.prepare(`
      INSERT INTO focus_messages (session_id, sender_jid, sender_name, text, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertStmt.run(sessionId, senderJid, senderName, text, Date.now());

    return { isFirstContact: count === 0 };
  }
}

export const appDatabase = new SQLiteDatabaseManager();
