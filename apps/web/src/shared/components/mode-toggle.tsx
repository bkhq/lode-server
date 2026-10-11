import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";
import { Button } from "./ui/button";

const icons = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

const next = { light: "dark", dark: "system", system: "light" } as const;

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = icons[theme];

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next[theme])}
      aria-label={`Theme: ${theme}, switch to ${next[theme]}`}
    >
      <Icon className="size-4" />
    </Button>
  );
}
