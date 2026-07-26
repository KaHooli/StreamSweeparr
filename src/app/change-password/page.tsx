"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/fetcher";

export const dynamic = "force-dynamic";

// Mandatory password-change screen shown when a session is flagged
// mustChangePassword (e.g. the seeded default admin). The middleware blocks
// all other routes until this succeeds.
export default function ChangePasswordPage() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/auth/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card card">
        <div className="brand" style={{ justifyContent: "center", marginBottom: 6 }}>
          <span className="mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/favicon-48x48.png" alt="" width={30} height={30} />
        </span>
          <span>
            <span className="sweep">Stream</span>
            <span className="arr">Sweeparr</span>
          </span>
        </div>
        <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
          You must set a new password before continuing.
        </p>

        {error && <div className="banner err">{error}</div>}

        <form onSubmit={submit}>
          <div className="field">
            <label>Current password</label>
            <input
              className="input"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label>New password</label>
            <input
              className="input"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              required
            />
            <div className="hint">At least 8 characters.</div>
          </div>
          <div className="field">
            <label>Confirm new password</label>
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button
            className="btn primary"
            type="submit"
            disabled={busy}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {busy ? <span className="spin" /> : null} Set new password
          </button>
        </form>
      </div>
    </div>
  );
}
