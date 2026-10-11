/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute } from "@tanstack/react-router";
import { Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Textarea } from "@/shared/components/ui/textarea";
import { http } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";

export const Route = createLazyFileRoute("/_app/admin/users/groups")({
  component: GroupsTab,
});

interface Group {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly source: "local" | "idp";
  readonly memberCount: number;
  readonly createdAt: string;
}

interface GroupMember {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly joinedAt: string;
}

interface GroupListResponse {
  success: boolean;
  data: Group[];
}

interface MemberListResponse {
  success: boolean;
  data: GroupMember[];
}

interface UserSearchItem {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
}

interface UserSearchResponse {
  success: boolean;
  data: UserSearchItem[];
  meta: { total: number };
}

function GroupsTab() {
  const { t } = useTranslation("groups");
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Group | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchItem[]>([]);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Derive the selected group from the live list so an edit/rename reflects
  // immediately in the member panel header instead of a stale snapshot.
  const selectedGroup = groups.find(g => g.id === selectedId) ?? null;

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await http<GroupListResponse>("/account/groups");
      setGroups(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  const fetchMembers = useCallback(async (groupId: string) => {
    setMembersLoading(true);
    try {
      const res = await http<MemberListResponse>(`/account/groups/${groupId}/members`);
      setMembers(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setMembersLoading(false);
    }
  }, [t]);

  const selectGroup = (group: Group) => {
    setSelectedId(group.id);
    void fetchMembers(group.id);
  };

  const handleUserSearchChange = (q: string) => {
    setUserSearch(q);
    clearTimeout(searchTimerRef.current);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await http<UserSearchResponse>(`/account/users?q=${encodeURIComponent(q)}&limit=10`);
        setSearchResults(res.data);
      }
      catch {
        setSearchResults([]);
      }
    }, 300);
  };

  const addMember = async (userId: string) => {
    if (!selectedId)
      return;
    try {
      await http(`/account/groups/${selectedId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setAddMemberOpen(false);
      setUserSearch("");
      setSearchResults([]);
      void fetchMembers(selectedId);
      void fetchGroups();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  };

  const removeMember = async (userId: string) => {
    if (!selectedId)
      return;
    try {
      await http(`/account/groups/${selectedId}/members/${userId}`, { method: "DELETE" });
      void fetchMembers(selectedId);
      void fetchGroups();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  };

  const confirmDeleteGroup = async () => {
    if (!deleteConfirm)
      return;
    try {
      await http(`/account/groups/${deleteConfirm.id}`, { method: "DELETE" });
      if (selectedId === deleteConfirm.id)
        setSelectedId(null);
      setDeleteConfirm(null);
      void fetchGroups();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteConfirm(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirm", { name: deleteConfirm?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void confirmDeleteGroup()}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Group list */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>{t("listTitle")}</CardTitle>
                <CardDescription>{t("listDescription")}</CardDescription>
              </div>
              <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogTrigger render={(
                  <Button size="sm">
                    <Plus className="mr-1 size-4" />
                    {t("create")}
                  </Button>
                )}
                />
                <DialogContent>
                  <GroupFormDialog
                    onSubmit={async (name, description) => {
                      await http("/account/groups", {
                        method: "POST",
                        body: JSON.stringify({ name, description: description || undefined }),
                      });
                      setCreateOpen(false);
                      void fetchGroups();
                    }}
                    title={t("createTitle")}
                    description={t("createDescription")}
                    submitLabel={t("create")}
                  />
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {loading
              ? <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
              : groups.length === 0
                ? <p className="text-sm text-muted-foreground">{t("noResults")}</p>
                : (
                    <div className="space-y-1.5">
                      {groups.map((group) => {
                        const active = selectedId === group.id;
                        return (
                          <div
                            key={group.id}
                            className={cn(
                              "group flex items-center gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors",
                              active
                                ? "border-primary bg-primary/5"
                                : "hover:bg-muted/50",
                            )}
                            role="button"
                            tabIndex={0}
                            aria-pressed={active}
                            onClick={() => selectGroup(group)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                selectGroup(group);
                              }
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium truncate">{group.name}</span>
                                <Badge variant="secondary" className="shrink-0">{group.memberCount}</Badge>
                                {group.source === "idp" && (
                                  <Badge variant="outline" className="shrink-0" title={t("idpManaged")}>{t("idpBadge")}</Badge>
                                )}
                              </div>
                              {group.description && (
                                <p className="text-xs text-muted-foreground truncate">{group.description}</p>
                              )}
                            </div>
                            <div
                              className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[active=true]:opacity-100"
                              data-active={active}
                              onClick={e => e.stopPropagation()}
                            >
                              <Dialog
                                open={editGroup?.id === group.id}
                                onOpenChange={(open) => {
                                  if (!open)
                                    setEditGroup(null);
                                }}
                              >
                                <DialogTrigger
                                  render={(
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label={t("common.edit")}
                                      onClick={() => setEditGroup(group)}
                                    >
                                      <Pencil className="size-3.5" />
                                    </Button>
                                  )}
                                />
                                <DialogContent>
                                  <GroupFormDialog
                                    initialName={group.name}
                                    nameLocked={group.source === "idp"}
                                    initialDescription={group.description ?? ""}
                                    onSubmit={async (name, description) => {
                                      await http(`/account/groups/${group.id}`, {
                                        method: "PATCH",
                                        body: JSON.stringify({ name, description: description || undefined }),
                                      });
                                      setEditGroup(null);
                                      void fetchGroups();
                                    }}
                                    title={t("editTitle")}
                                    description={t("editDescription")}
                                    submitLabel={t("common.save")}
                                  />
                                </DialogContent>
                              </Dialog>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("common.delete")}
                                className="text-destructive hover:text-destructive"
                                onClick={() => setDeleteConfirm(group)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
          </CardContent>
        </Card>

        {/* Member panel */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="truncate">
                  {selectedGroup ? t("membersOf", { name: selectedGroup.name }) : t("membersTitle")}
                </CardTitle>
                <CardDescription>
                  {selectedGroup?.source === "idp" ? t("idpManaged") : t("membersDescription")}
                </CardDescription>
              </div>
              {selectedGroup && selectedGroup.source !== "idp" && (
                <Dialog
                  open={addMemberOpen}
                  onOpenChange={(open) => {
                    setAddMemberOpen(open);
                    if (!open) {
                      setUserSearch("");
                      setSearchResults([]);
                    }
                  }}
                >
                  <DialogTrigger render={(
                    <Button size="sm">
                      <UserPlus className="mr-1 size-4" />
                      {t("addMember")}
                    </Button>
                  )}
                  />
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t("addMemberTitle")}</DialogTitle>
                      <DialogDescription>{t("addMemberDescription")}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                      <Input
                        placeholder={t("searchUserPlaceholder")}
                        value={userSearch}
                        onChange={e => handleUserSearchChange(e.target.value)}
                      />
                      {searchResults.length > 0 && (
                        <div className="max-h-48 overflow-y-auto rounded-md border">
                          {searchResults.map(u => (
                            <button
                              key={u.id}
                              type="button"
                              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                              onClick={() => void addMember(u.id)}
                            >
                              <div>
                                <div className="font-medium">{u.name}</div>
                                <div className="text-xs text-muted-foreground">{u.email}</div>
                              </div>
                              <Plus className="size-4 text-muted-foreground" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!selectedGroup
              ? <p className="text-sm text-muted-foreground">{t("selectGroup")}</p>
              : membersLoading
                ? <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                : members.length === 0
                  ? <p className="text-sm text-muted-foreground">{t("noMembers")}</p>
                  : (
                      <div className="space-y-1.5">
                        {members.map(member => (
                          <div
                            key={member.id}
                            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{member.name}</p>
                              <p className="text-xs text-muted-foreground truncate">
                                {member.username}
                                {" · "}
                                {member.email}
                              </p>
                            </div>
                            {selectedGroup.source !== "idp" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void removeMember(member.id)}
                                className="shrink-0 text-destructive hover:text-destructive"
                              >
                                <Trash2 className="mr-1 size-3.5" />
                                {t("removeMember")}
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function GroupFormDialog({
  initialName = "",
  initialDescription = "",
  nameLocked = false,
  onSubmit,
  title,
  description,
  submitLabel,
}: {
  readonly initialName?: string;
  readonly initialDescription?: string;
  /** The IdP owns the name of a group it manages; only the description is editable. */
  readonly nameLocked?: boolean;
  readonly onSubmit: (name: string, description: string) => Promise<void>;
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
}) {
  const [name, setName] = useState(initialName);
  const [desc, setDesc] = useState(initialDescription);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { t } = useTranslation("groups");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim())
      return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit(name.trim(), desc.trim());
    }
    catch (err) {
      setFormError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={e => void handleSubmit(e)}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        {formError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="group-name">{t("field.name")}</Label>
          <Input
            id="group-name"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={nameLocked}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="group-desc">{t("field.description")}</Label>
          <Textarea
            id="group-desc"
            value={desc}
            onChange={e => setDesc(e.target.value)}
            rows={3}
          />
        </div>
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        <Button type="submit" disabled={submitting || !name.trim()}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
