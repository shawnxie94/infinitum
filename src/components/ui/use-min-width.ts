"use client";

import { useEffect, useState } from "react";

/** lg 断点。默认 true，SSR/测试走宽屏生产布局。 */
export function useMinWidth(query = "(min-width: 1024px)", defaultValue = true) {
  const [matches, setMatches] = useState(defaultValue);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }

    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, [query]);

  return matches;
}
