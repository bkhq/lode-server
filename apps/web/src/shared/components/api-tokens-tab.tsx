import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Switch } from "@/shared/components/ui/switch";
import { formatDate } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";
import { queryClient } from "@/shared/lib/query-client";
import { registryKeys } from "@/shared/lib/registry/queries";

interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

interface TokenScope {
  readonly name: string;
  readonly description: string;
}

// The registry's token pages list the same tokens through TanStack Query;
// a token created or revoked here would otherwise stay stale on them.
function refreshRegistryTokens() {
  void queryClient.invalidateQueries({ queryKey: registryKeys.tokens() });
  void queryClient.invalidateQueries({ queryKey: registryKeys.adminTokens() });
}

export function ApiTokensTab() {
  const { t } = useTranslation(["common", "tokens"]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [scopes, setScopes] = useState<TokenScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [days, setDays] = useState("90");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [tokenRes, scopeRes] = await Promise.all([
        http<{ data: ApiToken[] }>("/account/me/tokens"),
        http<{ data: TokenScope[] }>("/account/token-scopes"),
      ]);
      setTokens(tokenRes.data);
      setScopes(scopeRes.data);
    }
    catch { /* ignore */ }
    finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const resetAdd = () => {
    setAdding(false);
    setName("");
    setChosen(new Set());
    setDays("90");
    setError(null);
  };

  const toggleScope = (scope: string, on: boolean) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on)
        next.add(scope);
      else
        next.delete(scope);
      return next;
    });
  };

  const handleCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const expiresInDays = days.trim() === "" ? undefined : Number(days);
      const res = await http<{ data: ApiToken & { token: string } }>("/account/me/tokens", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), scopes: [...chosen], expiresInDays }),
      });
      setSecret(res.data.token);
      resetAdd();
      void fetchAll();
      refreshRegistryTokens();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteId)
      return;
    await http(`/account/me/tokens/${deleteId}`, { method: "DELETE" });
    setTokens(prev => prev.filter(tk => tk.id !== deleteId));
    setDeleteId(null);
    refreshRegistryTokens();
  };

  const copySecret = async () => {
    if (!secret)
      return;
    await navigator.clipboard.writeText(secret);
    setCopied(true);
  };

  if (loading)
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("common.loading")}</div>;

  if (adding) {
    const validDays = days.trim() === "" || (/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650);
    return (
      <div className="space-y-4 pt-4">
        <div className="space-y-2">
          <Label htmlFor="token-name">{t("tokens:name")}</Label>
          <Input id="token-name" value={name} onChange={e => setName(e.target.value)} placeholder={t("tokens:namePlaceholder")} autoFocus />
        </div>
        <div className="space-y-2">
          <Label>{t("tokens:scopes")}</Label>
          <div className="space-y-2">
            {scopes.map(scope => (
              <label key={scope.name} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
                <span className="min-w-0">
                  <span className="block text-sm font-mono">{scope.name}</span>
                  <span className="block text-xs text-muted-foreground">{scope.description}</span>
                </span>
                <Switch checked={chosen.has(scope.name)} onCheckedChange={on => toggleScope(scope.name, on)} />
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="token-days">{t("tokens:expiresInDays")}</Label>
          <Input id="token-days" inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} placeholder={t("tokens:neverExpires")} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={resetAdd}>{t("common.cancel")}</Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!name.trim() || chosen.size === 0 || !validDays || submitting}
            aria-busy={submitting}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : t("tokens:create")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-4">
      {secret && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("tokens:copyNow")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{secret}</code>
            <Button variant="ghost" size="icon-xs" aria-label={t("tokens:copy")} onClick={() => void copySecret()}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSecret(null);
                setCopied(false);
              }}
            >
              {t("tokens:done")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("tokens:title")}</div>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} disabled={scopes.length === 0}>
          <Plus className="mr-1 size-3.5" />
          {t("tokens:add")}
        </Button>
      </div>

      {tokens.length === 0
        ? <p className="py-6 text-center text-sm text-muted-foreground">{t("tokens:none")}</p>
        : (
            <div className="space-y-2">
              {tokens.map(token => (
                <div key={token.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {token.name}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {token.prefix}
                          …
                        </span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{token.scopes.join(", ")}</div>
                      <div className="text-xs text-muted-foreground">
                        {token.expiresAt ? t("tokens:expires", { date: formatDate(token.expiresAt) }) : t("tokens:neverExpires")}
                        {" · "}
                        {token.lastUsedAt ? t("tokens:lastUsed", { date: formatDate(token.lastUsedAt) }) : t("tokens:neverUsed")}
                      </div>
                    </div>
                  </div>
                  {deleteId === token.id
                    ? (
                        <div className="flex items-center gap-1">
                          <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={() => void confirmDelete()}>
                            {t("tokens:revoke")}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setDeleteId(null)}>
                            {t("common.cancel")}
                          </Button>
                        </div>
                      )
                    : (
                        <Button variant="ghost" size="icon-xs" aria-label={t("tokens:revoke")} onClick={() => setDeleteId(token.id)}>
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      )}
                </div>
              ))}
            </div>
          )}
    </div>
  );
}
