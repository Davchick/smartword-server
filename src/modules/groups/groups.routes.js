const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /groups
 * Returns user's word groups with word_count, ordered by created_at asc.
 */
router.get('/', async (req, res) => {
  try {
    const groups = await prisma.wordGroup.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { words: true } },
      },
    });
    res.json(
      groups.map((g) => ({
        id: g.id,
        name: g.name,
        language: g.language,
        created_at: g.createdAt.toISOString(),
        word_count: g._count.words,
      }))
    );
  } catch (err) {
    console.error('[groups GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /groups
 * Body: { name, language }
 */
router.post('/', async (req, res) => {
  try {
    const { name, language } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const group = await prisma.wordGroup.create({
      data: {
        userId: req.user.id,
        name: name.trim(),
        language: typeof language === 'string' ? language.trim() : '',
      },
      include: { _count: { select: { words: true } } },
    });
    res.status(201).json({
      id: group.id,
      name: group.name,
      language: group.language,
      created_at: group.createdAt.toISOString(),
      word_count: group._count.words,
    });
  } catch (err) {
    console.error('[groups POST]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /groups/:id
 * Body: { name, language }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, language } = req.body;
    const existing = await prisma.wordGroup.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Group not found' });
    }
    const data = {};
    if (typeof name === 'string') data.name = name.trim();
    if (typeof language === 'string') data.language = language.trim();
    const updated = await prisma.wordGroup.update({
      where: { id },
      data,
      include: { _count: { select: { words: true } } },
    });
    res.json({
      id: updated.id,
      name: updated.name,
      language: updated.language,
      created_at: updated.createdAt.toISOString(),
      word_count: updated._count.words,
    });
  } catch (err) {
    console.error('[groups PATCH]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /groups/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.wordGroup.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Group not found' });
    }
    await prisma.wordGroup.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    console.error('[groups DELETE]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
