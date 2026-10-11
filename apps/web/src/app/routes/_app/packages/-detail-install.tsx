import type { Channel, RegistryPackage, Version } from "@/shared/lib/registry/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/shared/components/copy-button";
import { Button } from "@/shared/components/ui/button";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { formatDateTime } from "@/shared/lib/format";
import { keysQuery, manifestSignatureQuery } from "@/shared/lib/registry/queries";
import { buildSnippet } from "./-detail-snippet";

interface InstallTabProps {
  readonly pkg: RegistryPackage;
  readonly versions: readonly Version[];
  readonly channels: readonly Channel[];
  /** Whether the caller manages the package, and so its signing keys. */
  readonly canWrite: boolean;
  readonly onOpenKeys: () => void;
}

const DEFAULT_CHANNEL = "stable";
const FILE_NAME = "lode.toml";
const LINK_CLASS = "text-primary underline-offset-4 hover:underline";

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/toml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = FILE_NAME;
  link.click();
  URL.revokeObjectURL(url);
}

export function InstallTab({ pkg, versions, channels, canWrite, onOpenKeys }: InstallTabProps) {
  const { t } = useTranslation(["package", "common"]);
  const keys = useQuery(keysQuery(pkg.namespace, pkg.slug));
  const signature = useQuery(manifestSignatureQuery(pkg.namespace, pkg.slug)).data;
  const expiry = signature && signature.expires !== null ? formatDateTime(signature.expires * 1000) : null;
  const [channelChoice, setChannelChoice] = useState<string | null>(null);
  const [assetChoice, setAssetChoice] = useState<string | null>(null);

  // The choice falls back whenever it stops matching the data: the default
  // channel is `stable`, else the first; the default asset is the first.
  const channel = channels.find(c => c.name === channelChoice)
    ?? channels.find(c => c.name === DEFAULT_CHANNEL)
    ?? channels[0];
  const assets = versions.find(v => v.version === channel?.version)?.assets ?? [];
  const asset = assets.find(a => a.name === assetChoice) ?? assets[0];

  const snippet = buildSnippet({
    origin: window.location.origin,
    namespace: pkg.namespace,
    slug: pkg.slug,
    visibility: pkg.visibility,
    channel: channel?.name ?? null,
    asset: asset ? { name: asset.name, key_id: asset.key_id, run: asset.run } : null,
    keys: (keys.data ?? []).filter(k => k.revoked_at === null),
  });

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">{t("package:install.intro")}</p>

      {channel && (
        <div className="flex flex-wrap gap-4">
          <div className="space-y-2">
            <Label htmlFor="install-channel">{t("package:install.channel")}</Label>
            <Select
              value={channel.name}
              onValueChange={(v) => {
                setChannelChoice(v);
                setAssetChoice(null);
              }}
            >
              <SelectTrigger id="install-channel" className="min-w-40 font-mono">
                <SelectValue>{(v: string) => `${v} (${channels.find(c => c.name === v)?.version ?? ""})`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {channels.map(c => (
                  <SelectItem key={c.name} value={c.name}>{`${c.name} (${c.version})`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {asset && (
            <div className="space-y-2">
              <Label htmlFor="install-asset">{t("package:install.asset")}</Label>
              <Select value={asset.name} onValueChange={setAssetChoice}>
                <SelectTrigger id="install-asset" className="min-w-40 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assets.map(a => (
                    <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label>{t("package:install.manifestUrl")}</Label>
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5">
          <code className="flex-1 font-mono text-xs break-all">{snippet.manifestUrl}</code>
          <CopyButton value={snippet.manifestUrl} label={t("package:install.copyManifestUrl")} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("package:install.snippet")}</Label>
        <div className="relative rounded-md border bg-muted/30">
          <div className="absolute top-2 right-2">
            <CopyButton value={snippet.text} label={t("package:install.copySnippet")} />
          </div>
          <pre className="overflow-x-auto p-3 pr-10 font-mono text-xs leading-relaxed">{snippet.text}</pre>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => download(snippet.text)}>
            <Download className="size-3.5" />
            {t("package:install.download")}
          </Button>
          {snippet.complete && <span className="text-sm text-muted-foreground">{t("package:install.ready")}</span>}
        </div>
      </div>

      {!asset && <p className="text-sm text-muted-foreground">{t("package:install.noAsset")}</p>}

      {asset && snippet.signed && !snippet.keyKnown && (
        <p className="text-sm text-muted-foreground">{t("package:install.unknownKey")}</p>
      )}

      {asset && !snippet.signed && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm" role="alert">
          {t("package:install.unsignedWarning")}
          {" "}
          {canWrite && (
            <button type="button" className={LINK_CLASS} onClick={onOpenKeys}>{t("package:install.keysLink")}</button>
          )}
        </div>
      )}

      {signature && (
        <div className="space-y-1 text-sm">
          <Label>{t("package:install.manifestSignature")}</Label>
          {signature.status === "live"
            ? (
                <p className="text-muted-foreground">
                  {t("package:install.manifestLive", { key: signature.key_id })}
                  {expiry && ` ${t("package:install.manifestExpires", { date: expiry })}`}
                </p>
              )
            : (
                <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2" role="alert">
                  {signature.status === "stale" && t("package:install.manifestStale")}
                  {signature.status === "expired" && t("package:install.manifestExpired", { date: expiry ?? "" })}
                  {signature.status === "revoked" && t("package:install.manifestRevoked")}
                </p>
              )}
        </div>
      )}

      {pkg.visibility === "private" && (
        <p className="text-sm text-muted-foreground">
          {t("package:install.privateNote")}
          {" "}
          <Link to="/tokens" className={LINK_CLASS}>{t("package:install.tokensLink")}</Link>
        </p>
      )}
    </div>
  );
}
