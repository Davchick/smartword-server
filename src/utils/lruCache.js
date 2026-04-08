/**
 * LRU Cache с TTL для серверных кешей.
 * 
 * Заменяет ручные Map-реализации в stats, chatWords и других модулях.
 * 
 * Особенности:
 * - Настоящий LRU eviction (перемещение при доступе)
 * - Автоматическая очистка протухших записей
 * - Функция инвалидации по ключу
 * - O(1) get/set/delete
 */

class LRUCache {
  constructor(maxSize, ttlMs) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Проверка TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // LRU: перемещаем в конец (самый новый)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key, value) {
    // Если ключ уже существует — удаляем для перемещения в конец
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // LRU eviction: удаляем самый старую запись (первую в Map)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  /**
   * Принудительная очистка протухших записей.
   * Полезно вызывать периодически для больших кешей.
   */
  evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

module.exports = { LRUCache };
