function parseBooleanQuery(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parseDateQuery(value, { endOfDay = false } = {}) {
  if (!value) return undefined;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(endOfDay ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function parseNumberQuery(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return number;
}

function buildUsersWhere(query) {
  const search = String(query.search || '').trim();
  const isPremium = parseBooleanQuery(query.isPremium);
  const createdAfter = parseDateQuery(query.createdAfter);
  const createdBefore = parseDateQuery(query.createdBefore, { endOfDay: true });
  const hasWords = parseBooleanQuery(query.hasWords);
  const hasGroups = parseBooleanQuery(query.hasGroups);
  const verified = parseBooleanQuery(query.verified);
  const lastActiveAfter = parseDateQuery(query.lastActiveAfter);
  const lastActiveBefore = parseDateQuery(query.lastActiveBefore, { endOfDay: true });
  const wordsLearnedMin = parseNumberQuery(query.wordsLearnedMin);
  const wordsLearnedMax = parseNumberQuery(query.wordsLearnedMax);

  const where = {};
  const andConditions = [];

  if (search) {
    andConditions.push({
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { id: { contains: search, mode: 'insensitive' } },
      ],
    });
  }

  if (isPremium === true) {
    where.subscriptionExpiresAt = { gt: new Date() };
  } else if (isPremium === false) {
    const now = Date.now();
    andConditions.push({
      OR: [
        { subscriptionExpiresAt: null },
        { subscriptionExpiresAt: { lte: new Date(now) } },
      ],
    });
  }

  if (createdAfter || createdBefore) {
    where.createdAt = {};
    if (createdAfter) {
      where.createdAt.gte = createdAfter;
    }
    if (createdBefore) {
      where.createdAt.lte = createdBefore;
    }
  }

  if (verified !== undefined) {
    where.emailVerified = verified;
  }

  if (hasWords !== undefined) {
    where.words = hasWords ? { some: {} } : { none: {} };
  }

  if (hasGroups !== undefined) {
    where.groups = hasGroups ? { some: {} } : { none: {} };
  }

  if (lastActiveAfter || lastActiveBefore) {
    where.refreshTokens = {
      some: {
        lastUsedAt: {},
      },
    };
    if (lastActiveAfter) {
      where.refreshTokens.some.lastUsedAt.gte = lastActiveAfter;
    }
    if (lastActiveBefore) {
      where.refreshTokens.some.lastUsedAt.lte = lastActiveBefore;
    }
  }

  if (wordsLearnedMin !== undefined || wordsLearnedMax !== undefined) {
    where.wordsLearnedThisWeek = {};
    if (wordsLearnedMin !== undefined) where.wordsLearnedThisWeek.gte = wordsLearnedMin;
    if (wordsLearnedMax !== undefined) where.wordsLearnedThisWeek.lte = wordsLearnedMax;
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}

module.exports = {
  parseBooleanQuery,
  parseDateQuery,
  parseNumberQuery,
  buildUsersWhere,
};
