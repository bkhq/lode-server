import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/shared/components/copy-button";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { formatDateTime } from "@/shared/lib/format";
import { registryErrorMessage } from "@/shared/lib/registry/errors";
import { eventsQuery, instancesQuery } from "@/shared/lib/registry/queries";
import { versionCounts } from "./-detail-observe-data";
import { reportSnippet } from "./-detail-snippet";

const INSTANCE_COLUMNS = 6;
const EVENT_COLUMNS = 4;
const REFRESH_MS = 60_000;

interface ObserveTabProps {
  readonly ns: string;
  readonly pkg: string;
}

export function ObserveTab({ ns, pkg }: ObserveTabProps) {
  const { t } = useTranslation(["common", "package", "regerrors"]);
  const instances = useQuery({
    ...instancesQuery(ns, pkg),
    refetchInterval: REFRESH_MS,
  });
  const events = useQuery({
    ...eventsQuery(ns, pkg),
    refetchInterval: REFRESH_MS,
  });
  const snippet = reportSnippet(window.location.origin);
  const versions = versionCounts(instances.data ?? []);
  const error = instances.error ?? events.error;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("package:observe.description")}</p>
        <div className="relative rounded-md border bg-muted/30">
          <div className="absolute top-2 right-2">
            <CopyButton value={snippet} label={t("package:observe.copySnippet")} />
          </div>
          <pre className="overflow-x-auto p-3 pr-10 font-mono text-xs leading-relaxed">{snippet}</pre>
        </div>
        <p className="text-sm text-muted-foreground">{t("package:observe.otel")}</p>
      </div>

      {error && (
        <div className="flex items-center gap-3">
          <ErrorBanner className="flex-1" message={registryErrorMessage(error, t, t("common:common.error.loadFailed"))} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void instances.refetch();
              void events.refetch();
            }}
          >
            {t("common:common.retry")}
          </Button>
        </div>
      )}

      {versions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("package:observe.versions")}</h3>
          <div className="flex flex-wrap gap-2">
            {versions.map(v => (
              <Badge key={v.version ?? ""} variant="outline">
                {v.version ?? t("package:observe.unknownVersion")}
                {" · "}
                {v.count}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("package:observe.instances")}</h3>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("package:observe.col.instance")}</TableHead>
                <TableHead>{t("package:observe.col.version")}</TableHead>
                <TableHead>{t("package:observe.col.status")}</TableHead>
                <TableHead>{t("package:observe.col.platform")}</TableHead>
                <TableHead>{t("package:observe.col.lode")}</TableHead>
                <TableHead>{t("package:observe.col.lastSeen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={instances.isPending}>
              {instances.data === undefined || instances.data.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={INSTANCE_COLUMNS} className="h-24 text-center text-muted-foreground">
                        {instances.isPending
                          ? t("common:common.loading")
                          : instances.error
                            ? t("common:common.error.loadFailed")
                            : t("package:observe.noInstances")}
                      </TableCell>
                    </TableRow>
                  )
                : instances.data.map(i => (
                    <TableRow key={i.instance_id}>
                      <TableCell>
                        <div className="font-medium">{i.instance_id}</div>
                        {i.host_name && i.host_name !== i.instance_id && <div className="text-xs text-muted-foreground">{i.host_name}</div>}
                      </TableCell>
                      <TableCell><code className="font-mono text-xs">{i.version ?? "—"}</code></TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          {i.online
                            ? <Badge>{t("package:observe.online")}</Badge>
                            : <Badge variant="outline">{t("package:observe.offline")}</Badge>}
                          {i.status && <span className="text-xs text-muted-foreground">{i.status}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{[i.os_type, i.host_arch].filter(Boolean).join("/") || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{i.lode_version ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(i.last_seen_at)}</TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("package:observe.events")}</h3>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("package:observe.col.at")}</TableHead>
                <TableHead>{t("package:observe.col.instance")}</TableHead>
                <TableHead>{t("package:observe.col.event")}</TableHead>
                <TableHead>{t("package:observe.col.detail")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={events.isPending}>
              {events.data === undefined || events.data.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={EVENT_COLUMNS} className="h-24 text-center text-muted-foreground">
                        {events.isPending
                          ? t("common:common.loading")
                          : events.error
                            ? t("common:common.error.loadFailed")
                            : t("package:observe.noEvents")}
                      </TableCell>
                    </TableRow>
                  )
                : events.data.map(e => (
                    <TableRow key={e.id}>
                      <TableCell className="text-muted-foreground">{formatDateTime(e.at)}</TableCell>
                      <TableCell>{e.instance_id}</TableCell>
                      <TableCell><code className="font-mono text-xs">{e.name}</code></TableCell>
                      <TableCell className="text-muted-foreground">{e.body ?? ""}</TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
