"use client";

import {
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Play,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AutomationDetailSkeleton } from "../automation-detail-skeleton";
import { AutomationForm } from "../automation-form";
import {
  useAutomationDetail,
  useAutomations,
  type AutomationRecord,
} from "@/hooks/use-automations";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  formatAutomationDateTime,
  getNextCronOccurrence,
} from "@/lib/automations/cron";
import type { AutomationUpsertInput } from "@/lib/automations/types";

function getCronConfig(automation: AutomationRecord) {
  const cronTrigger = automation.triggers.find(
    (trigger) => trigger.type === "cron" && trigger.config.type === "cron",
  );
  return cronTrigger?.config.type === "cron" ? cronTrigger.config : null;
}

function toFormValue(
  automation: AutomationRecord,
): Partial<AutomationUpsertInput> {
  return {
    name: automation.name,
    instructions: automation.instructions,
    repoOwner: automation.repoOwner,
    repoName: automation.repoName,
    cloneUrl: automation.cloneUrl ?? undefined,
    baseBranch: automation.baseBranch,
    modelId: automation.modelId,
    enabled: automation.enabled,
    triggers: automation.triggers.map((trigger) => trigger.config),
    tools: automation.tools.map((tool) => tool.config),
    connections: automation.connections.map((connection) => ({
      provider: connection.provider,
      connectionRef: connection.connectionRef,
      config: connection.config,
    })),
  };
}

function formatRunTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

function getRunStatusDotColor(status: string) {
  switch (status) {
    case "completed":
      return "bg-emerald-500";
    case "running":
      return "bg-blue-500 animate-pulse";
    case "queued":
      return "bg-blue-400";
    case "needs_attention":
      return "bg-amber-500";
    case "failed":
    case "cancelled":
      return "bg-red-500";
    default:
      return "bg-zinc-400";
  }
}

function formatShortDate(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function AutomationDetailPage({
  automationId,
}: {
  automationId: string;
}) {
  const router = useRouter();
  const { automation, runs, error, isLoading, mutate } =
    useAutomationDetail(automationId);
  const { updateAutomation, deleteAutomation, runNow } = useAutomations();
  const [isRunningNow, setIsRunningNow] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const cronConfig = useMemo(
    () => (automation ? getCronConfig(automation) : null),
    [automation],
  );
  const isDeleted = automation?.deletedAt !== null;

  const nextPreview = useMemo(() => {
    if (!cronConfig) return "Not scheduled";

    try {
      return formatAutomationDateTime(
        automation?.nextRunAt
          ? new Date(automation.nextRunAt)
          : getNextCronOccurrence({
              cron: cronConfig.cron,
              timezone: cronConfig.timezone,
            }),
        cronConfig.timezone,
      );
    } catch {
      return "Not scheduled";
    }
  }, [automation?.nextRunAt, cronConfig]);

  if (isLoading) {
    return <AutomationDetailSkeleton />;
  }

  if (!automation) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Automation not found</h1>
        <p className="text-sm text-muted-foreground">
          {error instanceof Error
            ? error.message
            : "This automation could not be loaded."}
        </p>
        <Button asChild variant="outline">
          <Link href="/settings/automations">Back to automations</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── Breadcrumb ── */}
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link
          href="/settings/automations"
          className="hover:text-foreground hover:underline"
        >
          Automations
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground">{automation.name}</span>
      </nav>

      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{automation.name}</h1>
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isDeleted
                  ? "bg-zinc-300"
                  : automation.enabled
                    ? "bg-emerald-500"
                    : "bg-zinc-400",
              )}
            />
            <span className="text-xs text-muted-foreground">
              {isDeleted
                ? "Deleted"
                : automation.enabled
                  ? "Enabled"
                  : "Paused"}
            </span>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {automation.repoOwner}/{automation.repoName} on{" "}
            {automation.baseBranch}
          </p>
        </div>

        <div className="flex gap-2">
          {isDeleted ? null : (
            <>
              <Button
                disabled={isRunningNow}
                onClick={async () => {
                  setIsRunningNow(true);
                  try {
                    const result = await runNow(automation.id);
                    await mutate();
                    router.push(
                      `/sessions/${result.session.id}/chats/${result.chat.id}`,
                    );
                  } finally {
                    setIsRunningNow(false);
                  }
                }}
              >
                {isRunningNow ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Run now
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    disabled={isDeleting}
                    onClick={async () => {
                      const confirmed = window.confirm(
                        `Delete automation "${automation.name}"? Existing sessions and run history will remain, but future runs will stop.`,
                      );
                      if (!confirmed) return;

                      setIsDeleting(true);
                      try {
                        await deleteAutomation(automation.id);
                        router.push("/settings/automations");
                      } finally {
                        setIsDeleting(false);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>

      <Tabs defaultValue="overview" className="block space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {isDeleted ? null : <TabsTrigger value="edit">Edit</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="flex-none">
          <div className="space-y-8">
            {isDeleted ? (
              <div className="rounded-md border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                This automation was deleted on{" "}
                {formatRunTime(automation.deletedAt)}. Its existing sessions and
                run history are preserved, but it can no longer be edited or run
                again.
              </div>
            ) : null}
            {/* ── Schedule ── */}
            <div className="space-y-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Schedule
              </h2>
              <div className="space-y-4">
                <div className="grid gap-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Frequency
                  </p>
                  <p className="text-sm">{automation.scheduleSummary}</p>
                </div>
                <div className="grid gap-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Next run
                  </p>
                  <p className="text-sm">{nextPreview}</p>
                </div>
                {cronConfig ? (
                  <div className="grid gap-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      Timezone
                    </p>
                    <p className="text-sm">{cronConfig.timezone}</p>
                  </div>
                ) : null}
              </div>
            </div>

            {/* ── Tools ── */}
            <div className="space-y-4 border-t border-border/50 pt-8">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Tools
              </h2>
              {automation.enabledToolTypes.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {automation.enabledToolTypes.map((toolType) => (
                    <span
                      key={toolType}
                      className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                    >
                      {toolType.replaceAll("_", " ")}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No external tools enabled
                </p>
              )}
            </div>

            {/* ── Run History ── */}
            <div className="space-y-4 border-t border-border/50 pt-8">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Run History
              </h2>

              {runs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No runs yet. Use Run now or wait for the next scheduled
                  execution.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden sm:table-cell">
                        Triggered
                      </TableHead>
                      <TableHead className="hidden md:table-cell">
                        Summary
                      </TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                getRunStatusDotColor(run.status),
                              )}
                            />
                            <span className="text-xs">
                              {run.status.replaceAll("_", " ")}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                          {formatShortDate(run.triggeredAt)}
                        </TableCell>
                        <TableCell className="hidden max-w-xs truncate text-xs text-muted-foreground md:table-cell">
                          {run.resultSummary ?? "--"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {run.sessionId ? (
                              <Button
                                asChild
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                              >
                                <Link href={`/sessions/${run.sessionId}`}>
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </Link>
                              </Button>
                            ) : null}
                            {run.prUrl ? (
                              <Button
                                asChild
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                              >
                                <a
                                  href={run.prUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  <GitPullRequest className="h-3.5 w-3.5" />
                                </a>
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </TabsContent>

        {isDeleted ? null : (
          <TabsContent value="edit" className="flex-none">
            <AutomationForm
              key={automation.id}
              initialValue={toFormValue(automation)}
              submitLabel="Save changes"
              onSubmit={async (input) => {
                await updateAutomation(automation.id, input);
                await mutate();
              }}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
