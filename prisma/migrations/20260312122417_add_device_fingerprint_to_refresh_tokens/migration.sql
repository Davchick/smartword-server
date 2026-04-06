-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "deviceFingerprint" VARCHAR(64),
ADD COLUMN     "lastUsedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "RefreshToken_userId_deviceFingerprint_idx" ON "RefreshToken"("userId", "deviceFingerprint");
