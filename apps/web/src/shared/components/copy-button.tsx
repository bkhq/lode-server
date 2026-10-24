import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";

interface CopyButtonProps {
  readonly value: string;
  /** Already-translated aria-label and tooltip; defaults to the generic "Copy". */
  readonly label?: string;
}

const COPIED_MS = 2000;

export function CopyButton({ value, label }: CopyButtonProps) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  const text = label ?? t("common.copy");

  useEffect(() => {
    if (!copied)
      return;
    const timer = setTimeout(setCopied, COPIED_MS, false);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    }
    catch { /* clipboard unavailable or denied: leave the icon unchanged */ }
  };

  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={text} title={text} onClick={() => void copy()}>
      {copied
        ? <Check className="size-3.5" />
        : <Copy className="size-3.5" />}
    </Button>
  );
}
