"use client";

import { useState } from "react";

// Poster image with graceful fallback to a titled placeholder.
export function Poster({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <div className="poster placeholder">{title}</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="poster" src={src} alt={title} loading="lazy" onError={() => setFailed(true)} />;
}
