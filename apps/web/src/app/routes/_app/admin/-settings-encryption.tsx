import { Download, KeyRound, Save, Shield, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { APP_NAME } from "@/shared/lib/branding";
import { http, httpRaw } from "@/shared/lib/http";
import { ErrorBanner } from "./-settings-shared";

const RE_FILENAME = /filename="(.+?)"/;

interface BackupModuleInfo {
  readonly name: string;
  readonly deps: readonly string[];
}

function resolveModuleDeps(selected: Set<string>, modules: readonly BackupModuleInfo[]): Set<string> {
  const byName = new Map(modules.map(m => [m.name, m.deps]));
  const resolved = new Set(selected);
  for (const mod of selected) {
    for (const dep of byName.get(mod) ?? []) {
      resolved.add(dep);
    }
  }
  return resolved;
}

function getRequiredByDeps(mod: string, selected: Set<string>, modules: readonly BackupModuleInfo[]): string[] {
  const byName = new Map(modules.map(m => [m.name, m.deps]));
  return [...selected].filter(m => byName.get(m)?.includes(mod) ?? false);
}

interface EncryptionStatusData {
  encryptedDek: string | null;
  kdfSalt: string | null;
}

export function EncryptionSettingsTab() {
  const { t } = useTranslation(["common", "settings", "encryption"]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [meta, setMeta] = useState<EncryptionStatusData | null>(null);
  const [encryptionDisabled, setEncryptionDisabled] = useState(false);

  useEffect(() => {
    http<{ success: boolean; data: { status: string } }>("/encryption/status")
      .then((res) => {
        if (res.data.status === "disabled") {
          setEncryptionDisabled(true);
        }
      })
      .catch(() => {});
    http<{ success: boolean; data: EncryptionStatusData }>("/encryption/meta")
      .then(res => setMeta(res.data))
      .catch(() => {});
  }, []);

  const formValid = currentPassword.length > 0
    && newPassword.length >= 12
    && newPassword === confirmPassword;

  const handleChangePassword = async () => {
    if (!formValid || !meta?.encryptedDek || !meta.kdfSalt)
      return;
    setConfirmOpen(false);
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const { bytesToHex, deriveKeyPairFromPassword, eciesDecrypt, eciesEncrypt, generateSalt, hexToBytes } = await import("@app/shared");

      // Step 1: Verify old password — derive old key and decrypt encryptedDek to get DEK
      const oldKp = await deriveKeyPairFromPassword(currentPassword, meta.kdfSalt);
      let dekBytes: Uint8Array;
      try {
        dekBytes = await eciesDecrypt(oldKp.privateKey, hexToBytes(meta.encryptedDek));
      }
      catch {
        setError(t("settings:encryption.wrongPassword"));
        return;
      }

      // Step 2: Derive new keypair from new password
      const newSalt = generateSalt();
      const newKp = await deriveKeyPairFromPassword(newPassword, newSalt);

      // Step 3: Get ephemeral challenge from server
      const challengeRes = await http<{ success: boolean; data: { challengeId: string; ephemeralPublicKey: string } }>("/encryption/challenge", { method: "POST" });
      const { challengeId, ephemeralPublicKey } = challengeRes.data;

      // Step 4: Re-encrypt DEK with server's ephemeral key (DEK never sent as plaintext)
      const reEncrypted = await eciesEncrypt(ephemeralPublicKey, dekBytes);
      const reEncryptedHex = bytesToHex(reEncrypted);

      // Step 5: Send challenge + encrypted DEK + new public key to server
      await http("/encryption/change-master", {
        method: "POST",
        body: JSON.stringify({
          challengeId,
          encryptedDek: reEncryptedHex,
          publicKey: newKp.publicKey,
          kdfSalt: newSalt,
        }),
      });

      // Step 6: Refresh local meta with new encryptedDek
      const refreshed = await http<{ success: boolean; data: EncryptionStatusData }>("/encryption/meta");
      setMeta(refreshed.data);

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
      setTimeout(setSuccess, 3000, false);
    }
    catch (err) {
      if (!error)
        setError(err instanceof Error ? err.message : t("settings:encryption.changeFailed"));
    }
    finally {
      setSaving(false);
    }
  };

  // --- Export state ---
  const [exportPassword, setExportPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [availableModules, setAvailableModules] = useState<readonly BackupModuleInfo[]>([]);
  const [exportModules, setExportModules] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    http<{ modules: BackupModuleInfo[] }>("/backup/modules")
      .then((res) => {
        setAvailableModules(res.modules);
        setExportModules(new Set(res.modules.map(m => m.name)));
      })
      .catch(() => {});
  }, []);

  const resolvedExportModules = useMemo(
    () => resolveModuleDeps(exportModules, availableModules),
    [exportModules, availableModules],
  );

  const moduleDepsByName = useMemo(
    () => new Map(availableModules.map(m => [m.name, m.deps])),
    [availableModules],
  );

  const toggleExportModule = useCallback((mod: string) => {
    setExportModules((prev) => {
      const next = new Set(prev);
      if (next.has(mod)) {
        const requiredBy = getRequiredByDeps(mod, next, availableModules);
        if (requiredBy.length > 0)
          return prev;
        next.delete(mod);
      }
      else {
        next.add(mod);
        for (const dep of moduleDepsByName.get(mod) ?? []) {
          next.add(dep);
        }
      }
      return next;
    });
  }, [availableModules, moduleDepsByName]);

  const handleExport = async () => {
    setExportConfirmOpen(false);
    setExporting(true);
    setExportError(null);
    setExportSuccess(false);
    try {
      const modules = [...resolvedExportModules];
      let bodyObj: Record<string, unknown> = { modules };

      if (!encryptionDisabled) {
        if (!meta?.encryptedDek || !meta.kdfSalt)
          return;
        const { bytesToHex, deriveKeyPairFromPassword, eciesDecrypt, eciesEncrypt, hexToBytes } = await import("@app/shared");

        const kp = await deriveKeyPairFromPassword(exportPassword, meta.kdfSalt);
        let dekBytes: Uint8Array;
        try {
          dekBytes = await eciesDecrypt(kp.privateKey, hexToBytes(meta.encryptedDek));
        }
        catch {
          setExportError(t("settings:encryption.export.wrongPassword"));
          return;
        }

        const challengeRes = await http<{ success: boolean; data: { challengeId: string; ephemeralPublicKey: string } }>("/encryption/challenge", { method: "POST" });
        const { challengeId, ephemeralPublicKey } = challengeRes.data;

        const reEncrypted = await eciesEncrypt(ephemeralPublicKey, dekBytes);
        bodyObj = { ...bodyObj, challengeId, encryptedDek: bytesToHex(reEncrypted) };
      }

      const res = await httpRaw("/backup/export", {
        method: "POST",
        body: JSON.stringify(bodyObj),
      });

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      const filenameMatch = disposition?.match(RE_FILENAME);
      const filename = filenameMatch?.[1] ?? `${APP_NAME}-backup-${new Date().toISOString().slice(0, 10)}.json`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportPassword("");
      setExportSuccess(true);
      setTimeout(setExportSuccess, 3000, false);
    }
    catch (err) {
      setExportError(err instanceof Error ? err.message : t("settings:encryption.export.failed"));
    }
    finally {
      setExporting(false);
    }
  };

  // --- Import state ---
  const [importPassword, setImportPassword] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importFileModules, setImportFileModules] = useState<string[]>([]);
  // When checked, the operator opts in to restoring users / groups /
  // user_preferences. Off by default — the destructive nature (overwriting
  // the live user table) means we want a deliberate click. The backend
  // strips those tables when this flag is absent (see
  // apps/api/src/modules/backup/restore.routes.ts:105-108).
  const [importIncludeUsers, setImportIncludeUsers] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleImportFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file)
      return;
    setImportFile(file);
    setImportError(null);
    setImportSuccess(null);
    setImportFileModules([]);
    setImportIncludeUsers(false);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (data.version === 1 && Array.isArray(data.modules)) {
          setImportFileModules(data.modules);
        }
        else {
          setImportError(t("settings:encryption.import.invalidFormat"));
          setImportFile(null);
        }
      }
      catch {
        setImportError(t("settings:encryption.import.invalidJson"));
        setImportFile(null);
      }
    };
    reader.readAsText(file);
  }, [t]);

  const handleImport = async () => {
    if (!importFile)
      return;
    setImportConfirmOpen(false);
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      if (importIncludeUsers)
        formData.append("includeUsers", "true");

      if (!encryptionDisabled) {
        if (!meta?.encryptedDek || !meta.kdfSalt)
          return;
        const { bytesToHex, deriveKeyPairFromPassword, eciesDecrypt, eciesEncrypt, hexToBytes } = await import("@app/shared");

        const kp = await deriveKeyPairFromPassword(importPassword, meta.kdfSalt);
        let dekBytes: Uint8Array;
        try {
          dekBytes = await eciesDecrypt(kp.privateKey, hexToBytes(meta.encryptedDek));
        }
        catch {
          setImportError(t("settings:encryption.import.wrongPassword"));
          return;
        }

        const challengeRes = await http<{ success: boolean; data: { challengeId: string; ephemeralPublicKey: string } }>("/encryption/challenge", { method: "POST" });
        const { challengeId, ephemeralPublicKey } = challengeRes.data;

        const reEncrypted = await eciesEncrypt(ephemeralPublicKey, dekBytes);
        formData.append("challengeId", challengeId);
        formData.append("encryptedDek", bytesToHex(reEncrypted));
      }

      const res = await httpRaw("/backup/import", {
        method: "POST",
        body: formData,
      });

      const result = await res.json();
      setImportSuccess(t("settings:encryption.import.success", { tables: result.tablesImported, rows: result.rowsImported }));
      setImportFile(null);
      setImportFileModules([]);
      setImportPassword("");
      setImportIncludeUsers(false);
      if (importFileRef.current)
        importFileRef.current.value = "";
    }
    catch (err) {
      setImportError(err instanceof Error ? err.message : t("settings:encryption.import.failed"));
    }
    finally {
      setImporting(false);
    }
  };

  const moduleSelectionUI = (
    <div className="space-y-2">
      <Label className="text-xs">{t("settings:encryption.export.selectModules")}</Label>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {availableModules.map(({ name: mod }) => {
          const isSelected = resolvedExportModules.has(mod);
          const isDep = !exportModules.has(mod) && isSelected;
          const id = `export-mod-${mod}`;
          return (
            <label
              key={mod}
              htmlFor={id}
              className={`flex items-center gap-2 text-xs ${isDep ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer"}`}
            >
              <input
                id={id}
                type="checkbox"
                checked={isSelected}
                disabled={isDep}
                onChange={() => toggleExportModule(mod)}
                className="size-3.5 rounded border-border accent-primary"
              />
              {t(`settings:encryption.modules.${mod}`, { defaultValue: mod })}
            </label>
          );
        })}
      </div>
    </div>
  );

  const importSectionUI = (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Upload className="size-4 text-muted-foreground" />
        <h3 className="font-semibold">{t("settings:encryption.import.title")}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t("settings:encryption.import.description")}</p>

      {importError && <ErrorBanner message={importError} />}
      {importSuccess && (
        <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600">
          {importSuccess}
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">{t("settings:encryption.import.file")}</Label>
          <Input
            ref={importFileRef}
            type="file"
            accept=".json"
            onChange={handleImportFileChange}
          />
        </div>

        {importFileModules.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs">{t("settings:encryption.import.detectedModules")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {importFileModules.map(mod => (
                <Badge key={mod} variant="secondary">{t(`settings:encryption.modules.${mod}`, { defaultValue: mod })}</Badge>
              ))}
            </div>
          </div>
        )}

        {!encryptionDisabled && (
          <div className="space-y-1">
            <Label className="text-xs">{t("settings:encryption.import.password")}</Label>
            <Input
              type="password"
              value={importPassword}
              onChange={e => setImportPassword(e.target.value)}
              placeholder={t("settings:encryption.import.passwordPlaceholder")}
            />
          </div>
        )}

        {/* Users / groups / preferences are stripped server-side unless the
            operator explicitly opts in. The backup file ships them only when
            the export selected the `users` module — gate the checkbox on
            that signal so we never offer a no-op control. */}
        {importFileModules.includes("users") && (
          <label
            htmlFor="import-include-users"
            className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs"
          >
            <input
              id="import-include-users"
              type="checkbox"
              className="mt-0.5"
              checked={importIncludeUsers}
              onChange={e => setImportIncludeUsers(e.target.checked)}
            />
            <span className="space-y-0.5">
              <span className="block font-medium text-destructive">
                {t("settings:encryption.import.includeUsersLabel", "Restore users, groups, and preferences")}
              </span>
              <span className="block text-muted-foreground">
                {t(
                  "settings.encryption.import.includeUsersHint",
                  "Overwrites the live user table. Required for full disaster recovery / migration; leave off to merge only domain data into an existing tenant. Your own admin row must remain present and active in the backup, or the restore is rejected.",
                )}
              </span>
            </span>
          </label>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="destructive"
          disabled={!importFile || importing || (!encryptionDisabled && importPassword.length === 0)}
          onClick={() => setImportConfirmOpen(true)}
        >
          <Upload className="mr-1 size-3" />
          {importing ? t("settings:encryption.import.importing") : t("settings:encryption.import.button")}
        </Button>
      </div>
    </div>
  );

  const importConfirmDialog = (
    <Dialog open={importConfirmOpen} onOpenChange={setImportConfirmOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings:encryption.import.confirmTitle")}</DialogTitle>
          <DialogDescription>{t("settings:encryption.import.confirmDescription")}</DialogDescription>
        </DialogHeader>
        {importFileModules.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {importFileModules.map(mod => (
              <Badge key={mod} variant="secondary">{t(`settings:encryption.modules.${mod}`)}</Badge>
            ))}
          </div>
        )}
        {importFileModules.includes("users") && (
          <p className="px-1 text-xs">
            <span className="font-medium">
              {importIncludeUsers
                ? t("settings:encryption.import.confirmIncludeUsersOn", "Users, groups, and preferences WILL be overwritten.")
                : t("settings:encryption.import.confirmIncludeUsersOff", "Users, groups, and preferences will be skipped.")}
            </span>
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{t("common.cancel")}</Button>} />
          <Button variant="destructive" onClick={() => void handleImport()}>
            {t("settings:encryption.import.confirmButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (encryptionDisabled) {
    return (
      <div className="space-y-6 pt-4">
        <div>
          <h2 className="text-lg font-semibold">{t("settings:encryption.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("settings:encryption.description")}</p>
        </div>

        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-muted-foreground" />
            <h3 className="font-semibold">{t("settings:encryption.title")}</h3>
          </div>
          <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {t("settings:encryption.disabled")}
          </div>
        </div>

        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Download className="size-4 text-muted-foreground" />
            <h3 className="font-semibold">{t("settings:encryption.export.title")}</h3>
          </div>
          <p className="text-sm text-muted-foreground">{t("settings:encryption.export.noEncryption")}</p>

          {exportError && <ErrorBanner message={exportError} />}
          {exportSuccess && (
            <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600">
              {t("settings:encryption.export.success")}
            </div>
          )}

          {moduleSelectionUI}

          <div className="flex justify-end">
            <Button size="sm" disabled={exporting || resolvedExportModules.size === 0} onClick={() => setExportConfirmOpen(true)}>
              <Download className="mr-1 size-3" />
              {exporting ? t("settings:encryption.export.exporting") : t("settings:encryption.export.button")}
            </Button>
          </div>
        </div>

        {importSectionUI}

        <Dialog open={exportConfirmOpen} onOpenChange={setExportConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("settings:encryption.export.confirmTitle")}</DialogTitle>
              <DialogDescription>{t("settings:encryption.export.confirmDescription")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">{t("common.cancel")}</Button>} />
              <Button onClick={() => void handleExport()}>
                {t("settings:encryption.export.confirmButton")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {importConfirmDialog}
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-4">
      <div>
        <h2 className="text-lg font-semibold">{t("settings:encryption.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings:encryption.description")}</p>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h3 className="font-semibold">{t("settings:encryption.changePassword")}</h3>
        </div>

        {error && <ErrorBanner message={error} />}
        {success && (
          <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600">
            {t("settings:encryption.changeSuccess")}
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{t("settings:encryption.currentPassword")}</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder={t("settings:encryption.currentPasswordPlaceholder")}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("settings:encryption.newPassword")}</Label>
              <Input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={t("settings:encryption.newPasswordPlaceholder")}
              />
              {newPassword.length > 0 && newPassword.length < 12 && (
                <p className="text-xs text-destructive">{t("encryption:setup.step1.passwordTooShort")}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("settings:encryption.confirmPassword")}</Label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder={t("settings:encryption.confirmPasswordPlaceholder")}
              />
              {confirmPassword.length > 0 && newPassword !== confirmPassword && (
                <p className="text-xs text-destructive">{t("encryption:setup.step1.passwordMismatch")}</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button size="sm" disabled={!formValid || saving} onClick={() => setConfirmOpen(true)}>
            <Save className="mr-1 size-3" />
            {saving ? t("settings:saving") : t("settings:encryption.changeButton")}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {t("settings:encryption.changeNote")}
        </p>
      </div>

      {/* Export section */}
      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Download className="size-4 text-muted-foreground" />
          <h3 className="font-semibold">{t("settings:encryption.export.title")}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t("settings:encryption.export.description")}</p>

        {exportError && <ErrorBanner message={exportError} />}
        {exportSuccess && (
          <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600">
            {t("settings:encryption.export.success")}
          </div>
        )}

        <div className="space-y-3">
          {moduleSelectionUI}

          <div className="space-y-1">
            <Label className="text-xs">{t("settings:encryption.export.password")}</Label>
            <Input
              type="password"
              value={exportPassword}
              onChange={e => setExportPassword(e.target.value)}
              placeholder={t("settings:encryption.export.passwordPlaceholder")}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button size="sm" disabled={exportPassword.length === 0 || exporting || resolvedExportModules.size === 0} onClick={() => setExportConfirmOpen(true)}>
            <Download className="mr-1 size-3" />
            {exporting ? t("settings:encryption.export.exporting") : t("settings:encryption.export.button")}
          </Button>
        </div>
      </div>

      {/* Import section */}
      {importSectionUI}

      {/* Export confirmation dialog */}
      <Dialog open={exportConfirmOpen} onOpenChange={setExportConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings:encryption.export.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("settings:encryption.export.confirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">{t("common.cancel")}</Button>} />
            <Button onClick={() => void handleExport()}>
              {t("settings:encryption.export.confirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import confirmation dialog */}
      {importConfirmDialog}

      {/* Password change confirmation dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings:encryption.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("settings:encryption.confirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void handleChangePassword()}>
              {t("settings:encryption.confirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
