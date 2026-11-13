"use client";

import { useState } from "react";

/**
 * A read-only value with a Copy button — a URL or key the admin has to paste
 * into another program. Shared by the webhook and feed cards.
 */
export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<"ok" | "err" | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("ok");
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it just fails,
      // which is why the value stays selectable on screen either way.
      setCopied("err");
    }
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <label>{label}</label>
      <div className="row" style={{ alignItems: "stretch" }}>
        <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={copy}>
          {copied === "ok" ? "Copied ✓" : copied === "err" ? "Copy failed" : "Copy"}
        </button>
      </div>
    </div>
  );
}
