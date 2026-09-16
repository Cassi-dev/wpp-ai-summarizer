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
        is_group INTEGER NOT NULL
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
    `);
  }

  /**
   * Salva uma mensagem no banco de dados SQLite
   */
  public saveMessage(remoteJid: string, message: ChatMessage): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, remote_jid, sender, sender_name, text, timestamp, is_group)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      remoteJid,
      message.sender,
      message.senderName,
      message.text,
      message.timestamp.getTime(),
      message.isGroup ? 1 : 0
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
      SELECT id, sender, sender_name as senderName, text, timestamp, is_group as isGroup
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
}

export const appDatabase = new SQLiteDatabaseManager();
