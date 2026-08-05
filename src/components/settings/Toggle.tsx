"use client";

/** Labelled on/off switch used across the settings cards. */
export function Toggle({
  title,
  desc,
  checked,
  onChange,
  danger,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
}) {
  return (
    <div className="toggle-line">
      <div className="txt">
        <strong style={danger ? { color: "var(--danger)" } : undefined}>{title}</strong>
        <span>{desc}</span>
      </div>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="slider" />
      </label>
    </div>
  );
}
