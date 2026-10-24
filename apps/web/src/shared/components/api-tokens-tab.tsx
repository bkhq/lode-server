import { Check, Copy, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Switch } from "@/shared/components/ui/switch";
import { formatDate } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";

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

/** Scopes shown on a token row before the rest collapse into "+N". */
const VISIBLE_SCOPES = 3;

/** Creating a token, or editing the one given. */
type FormMode = { readonly kind: "create" } | { readonly kind: "edit"; readonly token: ApiToken };

export function ApiTokensTab() {
  const { t } = useTranslation(["common", "tokens"]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [scopes, setScopes] = useState<TokenScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormMode | null>(null);
  const [rotating, setRotating] = useState<ApiToken | null>(null);
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

  const confirmDelete = async () => {
    if (!deleteId)
      return;
    await http(`/account/me/tokens/${deleteId}`, { method: "DELETE" });
    setTokens(prev => prev.filter(tk => tk.id !== deleteId));
    setDeleteId(null);
  };

  const copySecret = async () => {
    if (!secret)
      return;
    await navigator.clipboard.writeText(secret);
    setCopied(true);
  };

  if (loading)
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("common.loading")}</div>;

  if (rotating) {
    return (
      <RotateForm
        token={rotating}
        onCancel={() => setRotating(null)}
        onRotated={(newSecret) => {
          setRotating(null);
          setSecret(newSecret);
          setCopied(false);
          void fetchAll();
        }}
      />
    );
  }

  if (form) {
    return (
      <TokenForm
        mode={form}
        scopes={scopes}
        onCancel={() => setForm(null)}
        onSaved={(saved) => {
          setForm(null);
          if (saved.token !== undefined)
            setSecret(saved.token);
          void fetchAll();
        }}
      />
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
              {copied
                ? <Check className="size-3.5" />
                : <Copy className="size-3.5" />}
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
        <Button variant="outline" size="sm" onClick={() => setForm({ kind: "create" })} disabled={scopes.length === 0}>
          <Plus className="mr-1 size-3.5" />
          {t("tokens:add")}
        </Button>
      </div>

      {tokens.length === 0
        ? <p className="py-6 text-center text-sm text-muted-foreground">{t("tokens:none")}</p>
        : (
            <div className="space-y-2">
              {tokens.map(token => (
                <div key={token.id} className="flex items-start justify-between gap-2 rounded-lg border px-3 py-2.5">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-sm font-medium">{token.name}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {token.prefix}
                          …
                        </span>
                      </div>
                      <ScopeBadges scopes={token.scopes} />
                      <div className="text-xs text-muted-foreground">
                        {token.expiresAt === null
                          ? t("tokens:neverExpires")
                          : Date.parse(token.expiresAt) <= Date.now()
                            ? (
                                <span className="text-destructive">
                                  {t("tokens:expired", {
                                    date: formatDate(token.expiresAt),
                                  })}
                                </span>
                              )
                            : t("tokens:expires", {
                                date: formatDate(token.expiresAt),
                              })}
                        {" · "}
                        {token.lastUsedAt
                          ? t("tokens:lastUsed", {
                              date: formatDate(token.lastUsedAt),
                            })
                          : t("tokens:neverUsed")}
                      </div>
                    </div>
                  </div>
                  {deleteId === token.id
                    ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={() => void confirmDelete()}>
                            {t("tokens:revoke")}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setDeleteId(null)}>
                            {t("common.cancel")}
                          </Button>
                        </div>
                      )
                    : (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button variant="ghost" size="icon-xs" aria-label={t("tokens:edit")} onClick={() => setForm({ kind: "edit", token })}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon-xs" aria-label={t("tokens:rotate")} onClick={() => setRotating(token)}>
                            <RefreshCw className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon-xs" aria-label={t("tokens:revoke")} onClick={() => setDeleteId(token.id)}>
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
                        </div>
                      )}
                </div>
              ))}
            </div>
          )}
    </div>
  );
}

function ScopeBadges({ scopes }: { readonly scopes: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded
    ? scopes
    : scopes.slice(0, VISIBLE_SCOPES);
  const hidden = scopes.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map(scope => (
        <Badge key={scope} variant="secondary" className="max-w-full font-mono">
          <span className="truncate">{scope}</span>
        </Badge>
      ))}
      {hidden > 0 && (
        <button type="button" title={scopes.slice(VISIBLE_SCOPES).join(", ")} onClick={() => setExpanded(true)}>
          <Badge variant="outline" className="cursor-pointer">
            +
            {hidden}
          </Badge>
        </button>
      )}
    </div>
  );
}

function isValidDays(days: string): boolean {
  return days.trim() === "" || (/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650);
}

function RotateForm({
  token,
  onCancel,
  onRotated,
}: {
  readonly token: ApiToken;
  readonly onCancel: () => void;
  readonly onRotated: (secret: string) => void;
}) {
  const { t } = useTranslation(["common", "tokens"]);
  const [days, setDays] = useState("90");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRotate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const expiresInDays = days.trim() === ""
        ? undefined
        : Number(days);
      const res = await http<{ data: ApiToken & { token: string } }>(`/account/me/tokens/${token.id}/rotate`, {
        method: "POST",
        body: JSON.stringify({ expiresInDays }),
      });
      onRotated(res.data.token);
    }
    catch (err) {
      setError(err instanceof Error
        ? err.message
        : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{token.name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {token.prefix}
            …
          </span>
        </div>
        <ScopeBadges scopes={token.scopes} />
      </div>
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
        {t("tokens:rotateWarning")}
      </p>
      <div className="space-y-2">
        <Label htmlFor="token-rotate-days">{t("tokens:expiresInDays")}</Label>
        <Input id="token-rotate-days" inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} placeholder={t("tokens:neverExpires")} autoFocus />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" onClick={() => void handleRotate()} disabled={!isValidDays(days) || submitting} aria-busy={submitting}>
          {submitting
            ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            : t("tokens:rotate")}
        </Button>
      </div>
    </div>
  );
}

function TokenForm({
  mode,
  scopes,
  onCancel,
  onSaved,
}: {
  readonly mode: FormMode;
  readonly scopes: readonly TokenScope[];
  readonly onCancel: () => void;
  readonly onSaved: (saved: { readonly token?: string }) => void;
}) {
  const { t } = useTranslation(["common", "tokens"]);
  const editing = mode.kind === "edit"
    ? mode.token
    : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(editing?.scopes));
  const [days, setDays] = useState("90");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const allChosen = scopes.length > 0 && scopes.every(s => chosen.has(s.name));

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (editing) {
        await http(`/account/me/tokens/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            scopes: [...chosen],
          }),
        });
        onSaved({});
      }
      else {
        const expiresInDays = days.trim() === ""
          ? undefined
          : Number(days);
        const res = await http<{ data: ApiToken & { token: string } }>("/account/me/tokens", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            scopes: [...chosen],
            expiresInDays,
          }),
        });
        onSaved({ token: res.data.token });
      }
    }
    catch (err) {
      setError(err instanceof Error
        ? err.message
        : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  const validDays = isValidDays(days);

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2">
        <Label htmlFor="token-name">{t("tokens:name")}</Label>
        <Input id="token-name" value={name} onChange={e => setName(e.target.value)} placeholder={t("tokens:namePlaceholder")} autoFocus />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("tokens:scopes")}</Label>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("tokens:selected", { n: chosen.size, total: scopes.length })}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setChosen(allChosen
                ? new Set()
                : new Set(scopes.map(s => s.name)))}
            >
              {allChosen
                ? t("tokens:selectNone")
                : t("tokens:selectAll")}
            </Button>
          </div>
        </div>
        <div className="max-h-60 divide-y overflow-y-auto rounded-lg border">
          {scopes.map(scope => (
            <label key={scope.name} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm">{scope.name}</span>
                <span className="block text-xs text-muted-foreground">{scope.description}</span>
              </span>
              <Switch checked={chosen.has(scope.name)} onCheckedChange={on => toggleScope(scope.name, on)} />
            </label>
          ))}
        </div>
      </div>
      {editing
        ? <p className="text-xs text-muted-foreground">{t("tokens:editHint")}</p>
        : (
            <div className="space-y-2">
              <Label htmlFor="token-days">{t("tokens:expiresInDays")}</Label>
              <Input id="token-days" inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} placeholder={t("tokens:neverExpires")} />
            </div>
          )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={!name.trim() || chosen.size === 0 || (!editing && !validDays) || submitting}
          aria-busy={submitting}
        >
          {submitting
            ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            : editing
              ? t("common.save")
              : t("tokens:create")}
        </Button>
      </div>
    </div>
  );
}
