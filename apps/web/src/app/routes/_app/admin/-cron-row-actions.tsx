import type { CronJob } from "./-cron-types";
import {
  ChevronDown,
  History,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";

// Row actions menu — the per-job dropdown rendered in the table's
// trailing cell. Lives in its own file so the lazy route can stay
// focused on data orchestration.

export function CronRowActions({
  job,
  onTrigger,
  onPause,
  onResume,
  onDelete,
  onViewLogs,
}: {
  readonly job: CronJob;
  readonly onTrigger: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onDelete: () => void;
  readonly onViewLogs: () => void;
}) {
  const { t } = useTranslation("cron");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="ghost" size="sm" aria-label="open actions">
            <ChevronDown className="size-4" />
          </Button>
        )}
      />
      <DropdownMenuContent align="end">
        {!job.isDeleted && (
          <>
            <DropdownMenuItem onClick={onTrigger}>
              <Play className="mr-2 size-4" />
              {t("actions.trigger")}
            </DropdownMenuItem>
            {job.enabled
              ? (
                  <DropdownMenuItem onClick={onPause}>
                    <Pause className="mr-2 size-4" />
                    {t("actions.pause")}
                  </DropdownMenuItem>
                )
              : (
                  <DropdownMenuItem onClick={onResume}>
                    <Play className="mr-2 size-4" />
                    {t("actions.resume")}
                  </DropdownMenuItem>
                )}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={onViewLogs}>
          <History className="mr-2 size-4" />
          {t("actions.viewLogs")}
        </DropdownMenuItem>
        {!job.isDeleted && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <Trash2 className="mr-2 size-4" />
              {t("actions.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
