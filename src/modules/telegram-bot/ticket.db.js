const Database = require('better-sqlite3');
const path = require('path');

let db = null;

const DB_PATH = path.join(__dirname, '../../../data/support_tickets.db');

/**
 * Инициализация БД
 */
function init() {
  // Создаём директорию если нет
  const fs = require('fs');
  const dataDir = path.join(__dirname, '../../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  
  // Таблица тикетов
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица сообщений
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      from_user TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    )
  `);

  // Индексы для скорости
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id)
  `);

  console.log('[Database] Support tickets DB initialized');
}

/**
 * Создать новый тикет
 */
function createTicket(userId, messageText) {
  const stmt = db.prepare(`
    INSERT INTO tickets (user_id, status) VALUES (?, 'new')
  `);
  const result = stmt.run(userId);
  
  const ticketId = result.lastInsertRowid;
  
  // Добавляем первое сообщение
  addMessage(ticketId, 'user', messageText);
  
  return getTicket(ticketId);
}

/**
 * Получить тикет по ID
 */
function getTicket(ticketId) {
  const stmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
  return stmt.get(ticketId);
}

/**
 * Получить открытый тикет пользователя
 */
function getOpenTicket(userId) {
  const stmt = db.prepare(`
    SELECT * FROM tickets 
    WHERE user_id = ? AND status != 'closed' 
    ORDER BY created_at DESC 
    LIMIT 1
  `);
  return stmt.get(userId);
}

/**
 * Получить все тикеты пользователя
 */
function getUserTickets(userId) {
  const stmt = db.prepare(`
    SELECT * FROM tickets 
    WHERE user_id = ? 
    ORDER BY created_at DESC
  `);
  return stmt.all(userId);
}

/**
 * Получить тикеты по статусу
 */
function getTicketsByStatus(status) {
  const stmt = db.prepare(`
    SELECT * FROM tickets 
    WHERE status = ? 
    ORDER BY created_at DESC
  `);
  return stmt.all(status);
}

/**
 * Обновить статус тикета
 */
function updateTicketStatus(ticketId, status) {
  const stmt = db.prepare(`
    UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `);
  stmt.run(status, ticketId);
}

/**
 * Добавить сообщение в тикет
 */
function addMessage(ticketId, from, text) {
  const stmt = db.prepare(`
    INSERT INTO messages (ticket_id, from_user, text) VALUES (?, ?, ?)
  `);
  stmt.run(ticketId, from, text);
  
  // Обновляем updated_at тикета
  db.prepare(`
    UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(ticketId);
}

/**
 * Получить все сообщения тикета
 */
function getTicketMessages(ticketId) {
  const stmt = db.prepare(`
    SELECT * FROM messages 
    WHERE ticket_id = ? 
    ORDER BY created_at ASC
  `);
  return stmt.all(ticketId);
}

/**
 * Получить последнее сообщение тикета
 */
function getLastMessage(ticketId) {
  const stmt = db.prepare(`
    SELECT * FROM messages 
    WHERE ticket_id = ? 
    ORDER BY created_at DESC 
    LIMIT 1
  `);
  return stmt.get(ticketId);
}

module.exports = {
  init,
  createTicket,
  getTicket,
  getOpenTicket,
  getUserTickets,
  getTicketsByStatus,
  updateTicketStatus,
  addMessage,
  getTicketMessages,
  getLastMessage,
};
