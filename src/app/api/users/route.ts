import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

// List all accounts (admins only). Never returns password hashes.
export const GET = withGuard(requireAdmin, async (session) => {
  const users = await prisma.user.findMany({ orderBy: { id: "asc" } });
  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      // "oidc" = provisioned by single sign-on, "local" = username/password.
      provider: u.oidcSubject ? "oidc" : "local",
      isLocalAccount: !!u.passwordHash,
      createdAt: u.createdAt,
      isSelf: u.id === session.sub,
    })),
  });
});
