-- Allow renaming the "Sign in with SSO" button on the login page.
ALTER TABLE "Settings" ADD COLUMN "oidcButtonLabel" TEXT;
