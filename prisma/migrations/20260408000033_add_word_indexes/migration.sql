-- CreateTable (if needed)
-- Add indexes to Word table for performance at scale
CREATE INDEX "Word_lastReviewed_idx" ON "Word"("lastReviewed");
CREATE INDEX "Word_correctCount_idx" ON "Word"("correctCount");
