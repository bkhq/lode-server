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
import { commitsQuery } from "@/shared/lib/registry/queries";

const COLUMNS = 6;
const SHORT_ID = 12;

interface CommitsTabProps {
  readonly ns: string;
  readonly pkg: string;
}

export function CommitsTab({ ns, pkg }: CommitsTabProps) {
  const { t } = useTranslation(["common", "package", "regerrors"]);
  const { data: commits, isPending, error, refetch } = useQuery(commitsQuery(ns, pkg));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("package:commits.description")}</p>

      {error && (
        <div className="flex items-center gap-3">
          <ErrorBanner className="flex-1" message={registryErrorMessage(error, t, t("common:common.error.loadFailed"))} />
          <Button variant="outline" size="sm" onClick={() => void refetch()}>{t("common:common.retry")}</Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("package:commits.col.generation")}</TableHead>
              <TableHead>{t("package:commits.col.id")}</TableHead>
              <TableHead>{t("package:commits.col.created")}</TableHead>
              <TableHead>{t("package:commits.col.channels")}</TableHead>
              <TableHead>{t("package:commits.col.changes")}</TableHead>
              <TableHead>{t("package:commits.col.key")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={isPending}>
            {commits === undefined || commits.length === 0
              ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS} className="h-24 text-center text-muted-foreground">
                      {isPending
                        ? t("common:common.loading")
                        : error
                          ? t("common:common.error.loadFailed")
                          : t("package:commits.empty")}
                    </TableCell>
                  </TableRow>
                )
              : commits.map(commit => (
                  <TableRow key={commit.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{commit.generation}</span>
                        {commit.head && <Badge>{t("package:commits.head")}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <code className="font-mono text-xs" title={commit.id}>{commit.id.slice(0, SHORT_ID)}</code>
                        <CopyButton value={commit.id} label={t("package:commits.copyId")} />
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(commit.created)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(commit.channels).map(([channel, version]) => (
                          <Badge key={channel} variant="outline">{`${channel} → ${version}`}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {commit.added.length === 0 && commit.dropped.length === 0
                        ? <span className="text-muted-foreground">{t("package:commits.noChanges")}</span>
                        : (
                            <div className="flex flex-wrap gap-1 font-mono text-xs">
                              {commit.added.map(version => <span key={`+${version}`}>{`+${version}`}</span>)}
                              {commit.dropped.map(version => <span key={`-${version}`} className="text-destructive">{`-${version}`}</span>)}
                            </div>
                          )}
                    </TableCell>
                    <TableCell><code className="font-mono text-xs">{commit.key_id}</code></TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
