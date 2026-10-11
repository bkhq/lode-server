import { useEffect, useState } from "react";

export function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(setDebounced, delay, value);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
