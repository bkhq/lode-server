import type { SettingRow } from "./-settings-shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Textarea } from "@/shared/components/ui/textarea";
import { http } from "@/shared/lib/http";
import { deleteSetting, ErrorBanner, saveSetting, useSettingsByPrefix } from "./-settings-shared";

export function WebhookSettingsTab() {
  const { t } = useTranslation(["common", "settings"]);
  const { settings, loading, error, setError, refetch } = useSettingsByPrefix("webhook.");
  const [addOpen, setAddOpen] = useState(false);

  const webhooks: { name: string; url: string; secret: boolean; events: string }[] = (() => {
    const names = settings.find(s => s.key === "webhook.endpoints")?.value;
    if (!names || names === "******")
      return [];
    try {
      const list = JSON.parse(names) as string[];
      return list.map(name => ({
        name,
        url: settings.find(s => s.key === `webhook.${name}.url`)?.value ?? "",
        secret: settings.some(s => s.key === `webhook.${name}.secret`),
        events: settings.find(s => s.key === `webhook.${name}.events`)?.value ?? "*",
      }));
    }
    catch {
      return [];
    }
  })();

  const handleDelete = async (name: string) => {
    try {
      const newList = webhooks.filter(w => w.name !== name).map(w => w.name);
      await saveSetting("webhook.endpoints", JSON.stringify(newList));
      const res = await http<{ success: boolean; data: SettingRow[] }>(`/settings?prefix=${encodeURIComponent(`webhook.${name}.`)}`);
      for (const row of res.data) {
        await deleteSetting(row.key);
      }
      void refetch();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
    }
  };

  return (
    <div className="space-y-4 pt-4">
      {error && <ErrorBanner message={error} />}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("settings:webhook.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("settings:webhook.description")}</p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1 size-3" />
          {t("settings:webhook.add")}
        </Button>
      </div>

      {loading
        ? <div className="py-8 text-center text-muted-foreground">{t("common.loading")}</div>
        : webhooks.length === 0
          ? <div className="rounded-md border py-8 text-center text-muted-foreground">{t("settings:webhook.noWebhooks")}</div>
          : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("settings:webhook.colName")}</TableHead>
                      <TableHead>{t("settings:webhook.colUrl")}</TableHead>
                      <TableHead>{t("settings:webhook.colEvents")}</TableHead>
                      <TableHead>{t("settings:webhook.colSecret")}</TableHead>
                      <TableHead className="w-16">{t("settings:col.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {webhooks.map(wh => (
                      <TableRow key={wh.name}>
                        <TableCell className="font-medium">{wh.name}</TableCell>
                        <TableCell className="font-mono text-sm">{wh.url || "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{wh.events === "*" ? t("settings:webhook.allEvents") : wh.events}</Badge>
                        </TableCell>
                        <TableCell>
                          {wh.secret
                            ? <Badge variant="secondary">{t("settings:webhook.fieldSecret")}</Badge>
                            : <Badge variant="outline">{t("settings:webhook.noSecret")}</Badge>}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon-sm" onClick={() => void handleDelete(wh.name)}>
                            <Trash2 className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

      <AddWebhookDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingNames={webhooks.map(w => w.name)}
        onSaved={refetch}
      />
    </div>
  );
}

// ─── Add Webhook Dialog ───

function AddWebhookDialog({
  open,
  onOpenChange,
  existingNames,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onSaved: () => void;
}) {
  const { t } = useTranslation(["common", "settings"]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState("*");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() && url.trim() && !existingNames.includes(name.trim());

  const handleAdd = async () => {
    if (!canSave)
      return;
    setSaving(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const newList = [...existingNames, trimmedName];
      await saveSetting("webhook.endpoints", JSON.stringify(newList));
      await saveSetting(`webhook.${trimmedName}.url`, url.trim());
      if (secret.trim()) {
        await saveSetting(`webhook.${trimmedName}.secret`, secret.trim());
      }
      await saveSetting(`webhook.${trimmedName}.events`, events.trim() || "*");
      setName("");
      setUrl("");
      setSecret("");
      setEvents("*");
      onOpenChange(false);
      onSaved();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings:webhook.addTitle")}</DialogTitle>
          <DialogDescription>{t("settings:webhook.addDescription")}</DialogDescription>
        </DialogHeader>
        {error && <ErrorBanner message={error} />}
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>{t("settings:webhook.colName")}</Label>
            <Input placeholder="my-webhook" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>{t("settings:webhook.colUrl")}</Label>
            <Input placeholder="https://example.com/webhook" value={url} onChange={e => setUrl(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>{t("settings:webhook.fieldSecret")}</Label>
            <Input type="password" placeholder={t("settings:webhook.secretPlaceholder")} value={secret} onChange={e => setSecret(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>{t("settings:webhook.colEvents")}</Label>
            <Textarea placeholder={t("settings:webhook.allEventsPlaceholder")} value={events} onChange={e => setEvents(e.target.value)} rows={2} />
            <p className="text-xs text-muted-foreground">{t("settings:webhook.eventsHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{t("common.cancel")}</Button>} />
          <Button disabled={!canSave || saving} onClick={() => void handleAdd()}>
            {saving ? t("settings:saving") : t("common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
