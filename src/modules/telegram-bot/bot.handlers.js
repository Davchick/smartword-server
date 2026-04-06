const db = require('./ticket.db');
const telegram = require('./bot.service');
const config = require('./bot.config');

// Временное хранилище состояний (ожидание ответа админа)
const adminReplyState = new Map(); // chat_id → { ticketId, messageId }

// Обработанные update_id
const processedUpdates = new Set();

/**
 * Обработка сообщения от пользователя
 */
async function handleUserMessage(update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text || '';
  const from = message.from;

  // Команда /start
  if (text === '/start') {
    await telegram.sendMessage(
      chatId,
      `👋 Привет, ${from.first_name}!\n\n` +
        `Напишите ваше обращение — я передам его разработчику.\n` +
        `Я отвечу вам здесь, как только получу ответ.`,
    );
    return;
  }

  // Команда /help
  if (text === '/help') {
    await telegram.sendMessage(
      chatId,
      'Напишите ваше сообщение — я передам его разработчику.\n\n' +
        'Команды:\n' +
        '/start — начать общение\n' +
        '/help — эта справка',
    );
    return;
  }

  // Обычное сообщение — создаём или обновляем тикет
  await handleNewTicket(chatId, from, text);
}

/**
 * Создание нового тикета или обновление существующего
 */
async function handleNewTicket(userId, from, messageText) {
  try {
    // Ищем открытый тикет
    const existingTicket = db.getOpenTicket(userId.toString());

    if (existingTicket) {
      // Обновляем существующий
      db.addMessage(existingTicket.id, 'user', messageText);

      // Если тикет был закрыт — открываем
      if (existingTicket.status === 'closed') {
        db.updateTicketStatus(existingTicket.id, 'open');
      }

      // Уведомляем админа об обновлении
      await notifyTicketUpdate(existingTicket.id, userId, from, messageText);
    } else {
      // Создаём новый тикет
      const ticket = db.createTicket(userId.toString(), messageText);

      // Уведомляем админа о новом тикете
      await notifyNewTicket(ticket, userId, from, messageText);

      // Подтверждение пользователю (только для новых тикетов)
      await telegram.sendMessage(
        userId,
        '✅ Ваше сообщение отправлено разработчику.\n' +
          'Я отвечу вам здесь, как только получу ответ.',
      );
    }

    console.log(`[Telegram] Ticket from ${userId}: ${messageText.substring(0, 50)}`);
  } catch (err) {
    console.error('[Telegram] Error handling ticket:', err);
    await telegram.sendMessage(userId, '❌ Произошла ошибка. Попробуйте позже.');
  }
}

/**
 * Уведомление админа о новом тикете
 */
async function notifyNewTicket(ticket, userId, from, messageText) {
  const adminChatId = config.getAdminChatId();

  const text =
    `🆕 <b>НОВЫЙ ТИКЕТ #${ticket.id}</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 <b>${from.first_name || ''} ${from.last_name || ''}</b>\n` +
    `🆔 <code>${userId}</code>\n` +
    `⏰ ${formatTime(new Date())}\n\n` +
    `✉️ <b>Сообщение:</b>\n${messageText}\n` +
    `━━━━━━━━━━━━━━━━`;

  const keyboard = {
    inline_keyboard: [[
      { text: '📝 Ответить', callback_data: `reply_${ticket.id}` },
      { text: 'ℹ️ О пользователе', callback_data: `user_${ticket.id}` },
    ]],
  };

  await telegram.sendInline(adminChatId, text, keyboard);
}

/**
 * Уведомление админа об обновлении тикета
 */
async function notifyTicketUpdate(ticketId, userId, from, messageText) {
  const adminChatId = config.getAdminChatId();
  const ticket = db.getTicket(ticketId);
  const messageCount = db.getTicketMessages(ticketId).length;

  const statusEmoji = { new: '🆕', open: '🟡', closed: '✅' };
  const statusText = { new: 'Новый', open: 'В работе', closed: 'Закрыт' };

  const text =
    `🔔 <b>ТИКЕТ #${ticketId} — НОВОЕ СООБЩЕНИЕ</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 <b>${from.first_name || ''}</b>\n` +
    `🆔 <code>${userId}</code>\n` +
    `📊 Статус: ${statusEmoji[ticket.status]} ${statusText[ticket.status]}\n` +
    `📬 Сообщений: ${messageCount}\n` +
    `⏰ ${formatTime(new Date())}\n\n` +
    `✉️ <b>Сообщение:</b>\n${messageText}\n` +
    `━━━━━━━━━━━━━━━━`;

  const keyboard = {
    inline_keyboard: [[
      { text: '📝 Ответить', callback_data: `reply_${ticketId}` },
      { text: '✅ Закрыть', callback_data: `close_${ticketId}` },
    ], [
      { text: '📋 История', callback_data: `history_${ticketId}` },
    ]],
  };

  await telegram.sendInline(adminChatId, text, keyboard);
}

/**
 * Обработка callback от inline кнопок
 */
async function handleCallback(update) {
  const callbackQuery = update.callback_query;
  if (!callbackQuery) return;

  const chatId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;

  // Проверяем, что это админ
  if (chatId.toString() !== config.getAdminChatId().toString()) {
    return;
  }

  // СРАЗУ подтверждаем callback чтобы Telegram не слал повторно
  await telegram.answerCallbackQuery(callbackQuery.id);

  const [action, param] = data.split('_');

  switch (action) {
    case 'reply':
      await handleReplyButton(chatId, messageId, parseInt(param));
      break;
    case 'close':
      await handleCloseButton(chatId, messageId, parseInt(param));
      break;
    case 'history':
      await handleHistoryButton(chatId, messageId, parseInt(param));
      break;
    case 'back':
      await handleBackButton(chatId, messageId, parseInt(param));
      break;
  }
}

/**
 * Кнопка "Ответить"
 */
async function handleReplyButton(adminChatId, messageId, ticketId) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) {
    await telegram.sendMessage(adminChatId, '❌ Тикет не найден');
    return;
  }

  // Сохраняем состояние ожидания ответа
  adminReplyState.set(adminChatId.toString(), { ticketId, messageId });

  await telegram.sendMessage(
    adminChatId,
    `✏️ <b>Введите ответ для тикета #${ticketId}</b>\n\n` +
      `Просто отправьте текст следующим сообщением — я перешлю его пользователю.`,
  );
}

/**
 * Кнопка "Закрыть"
 */
async function handleCloseButton(adminChatId, messageId, ticketId) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) {
    await telegram.sendMessage(adminChatId, '❌ Тикет не найден');
    return;
  }

  db.updateTicketStatus(ticketId, 'closed');

  // Уведомляем пользователя
  await telegram.sendMessage(
    ticket.user_id,
    '✅ <b>Ваше обращение закрыто</b>\n\n' +
      'Если у вас появятся ещё вопросы — пишите, ответим.',
  );

  // Обновляем сообщение админа
  await telegram.editMessage(adminChatId, messageId,
    `✅ <b>ТИКЕТ #${ticketId} — ЗАКРЫТ</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 Пользователь: <code>${ticket.user_id}</code>\n` +
    `🕐 Закрыт: ${formatTime(new Date())}\n` +
    `━━━━━━━━━━━━━━━━`,
    {}
  );

  await telegram.sendMessage(adminChatId, `✅ Тикет #${ticketId} закрыт`);
}

/**
 * Кнопка "Назад к тику" (из истории)
 */
async function handleBackButton(adminChatId, messageId, ticketId) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) {
    await telegram.sendMessage(adminChatId, '❌ Тикет не найден');
    return;
  }

  const statusEmoji = { new: '🆕', open: '🟡', closed: '✅' };
  const statusText = { new: 'Новый', open: 'В работе', closed: 'Закрыт' };
  const messages = db.getTicketMessages(ticketId);
  const lastMessage = messages[messages.length - 1];

  const text =
    `📋 <b>ТИКЕТ #${ticketId}</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 Пользователь: <code>${ticket.user_id}</code>\n` +
    `📊 Статус: ${statusEmoji[ticket.status]} ${statusText[ticket.status]}\n` +
    `📬 Сообщений: ${messages.length}\n` +
    `⏰ Создан: ${formatTime(new Date(ticket.created_at))}\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `💬 <b>Последнее сообщение:</b>\n${lastMessage?.text || '—'}\n`;

  const keyboard = {
    inline_keyboard: [[
      { text: '📝 Ответить', callback_data: `reply_${ticketId}` },
      { text: '✅ Закрыть', callback_data: `close_${ticketId}` },
    ], [
      { text: '📋 История', callback_data: `history_${ticketId}` },
    ]],
  };

  await telegram.sendInline(adminChatId, text, keyboard);
}

/**
 * Кнопка "История"
 */
async function handleHistoryButton(adminChatId, messageId, ticketId) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) {
    await telegram.sendMessage(adminChatId, '❌ Тикет не найден');
    return;
  }

  const messages = db.getTicketMessages(ticketId);
  const statusEmoji = { new: '🆕', open: '🟡', closed: '✅' };
  const statusText = { new: 'Новый', open: 'В работе', closed: 'Закрыт' };

  let historyText =
    `📋 <b>ИСТОРИЯ ТИКЕТА #${ticketId}</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 Пользователь: <code>${ticket.user_id}</code>\n` +
    `📊 Статус: ${statusEmoji[ticket.status]} ${statusText[ticket.status]}\n` +
    `━━━━━━━━━━━━━━━━\n\n`;

  messages.forEach(msg => {
    const sender = msg.from_user === 'user' ? '👤 Пользователь' : '🛠 Вы';
    const time = formatTime(new Date(msg.created_at));
    historyText += `${time} — ${sender}:\n${msg.text}\n\n`;
  });

  const keyboard = {
    inline_keyboard: [[
      { text: '← Назад к тику', callback_data: `back_${ticketId}` },
    ]],
  };

  await telegram.sendInline(adminChatId, historyText, keyboard);
}

/**
 * Обработка ответа админа (сообщение после нажатия "Ответить")
 */
async function handleAdminReply(adminChatId, text) {
  const state = adminReplyState.get(adminChatId.toString());
  if (!state) {
    return; // Не в режиме ответа
  }

  const { ticketId } = state;
  const ticket = db.getTicket(ticketId);

  if (!ticket) {
    await telegram.sendMessage(adminChatId, '❌ Тикет не найден');
    adminReplyState.delete(adminChatId.toString());
    return;
  }

  // Проверяем что userId существует
  if (!ticket.user_id) {
    console.error('[Telegram] Ticket has no user_id:', ticket);
    await telegram.sendMessage(adminChatId, `❌ Ошибка: пользователь не найден`);
    adminReplyState.delete(adminChatId.toString());
    return;
  }

  // Сохраняем сообщение
  db.addMessage(ticketId, 'admin', text);

  // Отправляем пользователю
  try {
    await telegram.sendMessage(
      ticket.user_id,
      text,
    );

    // Обновляем статус
    if (ticket.status === 'new') {
      db.updateTicketStatus(ticketId, 'open');
    }

    await telegram.sendMessage(adminChatId, `✅ Ответ отправлен пользователю`);
  } catch (err) {
    console.error('[Telegram] Error sending reply:', err);
    await telegram.sendMessage(adminChatId, `❌ Не удалось отправить ответ`);
  }

  // Очищаем состояние
  adminReplyState.delete(adminChatId.toString());
}

/**
 * Обработка команд админа
 */
async function handleAdminCommand(chatId, command) {
  if (chatId.toString() !== config.getAdminChatId().toString()) {
    return;
  }

  if (command === '/new') {
    const tickets = db.getTicketsByStatus('new');
    if (tickets.length === 0) {
      await telegram.sendMessage(chatId, '✅ Нет новых тикетов');
      return;
    }
    await telegram.sendMessage(chatId, `🆕 <b>Новые тикеты:</b>\n\n` +
      tickets.map(t => `#${t.id} — Пользователь ${t.userId}`).join('\n'));
  }

  if (command === '/active') {
    const tickets = db.getTicketsByStatus('open');
    if (tickets.length === 0) {
      await telegram.sendMessage(chatId, '✅ Нет активных тикетов');
      return;
    }
    await telegram.sendMessage(chatId, `🟡 <b>Активные тикеты:</b>\n\n` +
      tickets.map(t => `#${t.id} — Пользователь ${t.userId}`).join('\n'));
  }

  if (command === '/closed') {
    const tickets = db.getTicketsByStatus('closed');
    if (tickets.length === 0) {
      await telegram.sendMessage(chatId, '✅ Нет закрытых тикетов');
      return;
    }
    await telegram.sendMessage(chatId, `✅ <b>Закрытые тикеты:</b>\n\n` +
      tickets.map(t => `#${t.id} — Пользователь ${t.userId}`).join('\n'));
  }
}

/**
 * Основная обработка обновлений
 */
async function handleUpdate(update) {
  if (!update) return;

  // Callback query (кнопки)
  if (update.callback_query) {
    console.log('[Telegram] Callback:', update.callback_query.data, 'from:', update.callback_query.from.id, 'update_id:', update.update_id);

    // Пропускаем уже обработанные
    if (processedUpdates.has(update.update_id)) {
      console.log('[Telegram] SKIP callback - already processed:', update.update_id);
      return;
    }
    processedUpdates.add(update.update_id);
    cleanSet(processedUpdates, config.MAX_PROCESSED_UPDATES);

    await handleCallback(update);
    return;
  }

  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text || '';

  console.log('[Telegram] Message:', { update_id: update.update_id, chatId, from: message.from?.username, text: text.substring(0, 50) });

  // Пропускаем уже обработанные update_id
  if (processedUpdates.has(update.update_id)) {
    console.log('[Telegram] SKIP - already processed:', update.update_id);
    return;
  }
  processedUpdates.add(update.update_id);
  cleanSet(processedUpdates, config.MAX_PROCESSED_UPDATES);

  // Игнорируем сообщения от самого бота
  if (message.from && message.from.is_bot) {
    console.log('[Telegram] SKIP - message from bot');
    return;
  }

  // Игнорируем служебные сообщения бота (режим ответа)
  if (chatId.toString() === config.getAdminChatId().toString() && text.includes('✏️ Введите ответ для тикета #')) {
    console.log('[Telegram] SKIP - service message');
    return;
  }

  // Команды админа
  if (chatId.toString() === config.getAdminChatId().toString() && text.startsWith('/')) {
    console.log('[Telegram] Admin command:', text);
    await handleAdminCommand(chatId, text);
    return;
  }

  // Ответ админа (режим ответа)
  if (chatId.toString() === config.getAdminChatId().toString()) {
    console.log('[Telegram] Admin reply');
    await handleAdminReply(chatId, text);
    return;
  }

  // Сообщение от пользователя
  console.log('[Telegram] User message');
  await handleUserMessage(update);
}

/**
 * Очистка множества
 */
function cleanSet(set, max) {
  while (set.size > max) {
    const first = set.keys().next().value;
    if (first !== undefined) set.delete(first);
  }
}

/**
 * Форматирование времени
 */
function formatTime(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  handleUpdate,
  handleUserMessage,
  handleCallback,
};
