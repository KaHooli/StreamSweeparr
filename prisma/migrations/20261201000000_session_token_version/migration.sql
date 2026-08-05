-- Session revocation.
--
-- Session tokens are stateless (signed, not stored), so before this column a
-- role change or account deletion did not take effect until the token expired
-- up to 7 days later. Tokens now embed the account's tokenVersion and the
-- server-side guard rejects any token whose version is behind, which makes
-- demotion, password changes and deletion effective immediately.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
