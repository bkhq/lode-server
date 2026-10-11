import { CopyButton } from "@/shared/components/copy-button";

/** A copyable block of configuration or shell. */
export function Code({ children, label }: { readonly children: string; readonly label: string }) {
  return (
    <div className="relative rounded-md border bg-muted/40">
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={children} label={label} />
      </div>
      <pre className="overflow-x-auto p-4 pr-12 font-mono text-xs leading-relaxed">{children}</pre>
    </div>
  );
}
