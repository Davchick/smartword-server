const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUsersWhere } = require('../src/modules/admin/usersFilters');

test('buildUsersWhere combines search and premium=false via AND without overwrite', () => {
  const where = buildUsersWhere({
    search: 'john',
    isPremium: 'false',
  });

  assert.ok(Array.isArray(where.AND));
  assert.equal(where.AND.length, 2);
  assert.ok(where.AND[0].OR);
  assert.ok(where.AND[1].OR);
});

test('buildUsersWhere keeps range and boolean filters', () => {
  const where = buildUsersWhere({
    createdAfter: '2026-01-01',
    createdBefore: '2026-01-31',
    verified: 'true',
    hasWords: 'false',
    wordsLearnedMin: '3',
    wordsLearnedMax: '7',
  });

  assert.equal(where.emailVerified, true);
  assert.deepEqual(where.words, { none: {} });
  assert.ok(where.createdAt.gte instanceof Date);
  assert.ok(where.createdAt.lte instanceof Date);
  assert.equal(where.wordsLearnedThisWeek.gte, 3);
  assert.equal(where.wordsLearnedThisWeek.lte, 7);
});

test('buildUsersWhere ignores invalid boolean and date filters', () => {
  const where = buildUsersWhere({
    isPremium: 'premium',
    createdAfter: 'not-a-date',
    createdBefore: '2026-02-31',
    lastActiveAfter: '2026/01/01',
    wordsLearnedMin: 'abc',
  });

  assert.equal(where.subscriptionExpiresAt, undefined);
  assert.equal(where.createdAt, undefined);
  assert.equal(where.refreshTokens, undefined);
  assert.equal(where.wordsLearnedThisWeek, undefined);
});
