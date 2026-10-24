/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute } from "@tanstack/react-router";
import { Search, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { useDebounce } from "@/shared/hooks/use-debounce";
import { formatDateTime } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";
import { useAuthStore } from "@/shared/stores/auth";
import { AddUserDialog, SetPasswordDialog } from "./-password-dialogs";

export const Route = createLazyFileRoute("/_app/admin/users/")({
  component: UsersTab,
});

const ALL = "__all__";

interface UserGroup {
  readonly id: string;
  readonly name: string;
}

interface User {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "user";
  readonly status: "active" | "disabled";
  readonly groups?: UserGroup[];
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

interface ListResponse {
  success: boolean;
  data: User[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

function UsersTab() {
  const { t } = useTranslation("users");
  const currentUser = useAuthStore(s => s.user);
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [roleFilter, setRoleFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleConfirm, setRoleConfirm] = useState<User | null>(null);
  // Accounts with passwords exist only when the deployment allows them.
  const [localLogin, setLocalLogin] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<User | null>(null);

  useEffect(() => {
    void http<{ data: { localLogin?: boolean } }>("/account/auth/mode")
      .then(res => setLocalLogin(res.data.localLogin === true))
      .catch(() => setLocalLogin(false));
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch)
        params.set("q", debouncedSearch);
      if (roleFilter !== ALL)
        params.set("role", roleFilter);
      if (statusFilter !== ALL)
        params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("limit", "20");

      const res = await http<ListResponse>(`/account/users?${params.toString()}`);
      setUsers(res.data);
      setMeta({ total: res.meta.total, totalPages: res.meta.totalPages });
    }
    catch (err) {
      setError(err instanceof Error
        ? err.message
        : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [
    debouncedSearch,
    roleFilter,
    statusFilter,
    page,
    t,
  ]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const confirmToggleRole = async () => {
    if (!roleConfirm)
      return;
    try {
      const newRole = roleConfirm.role === "admin"
        ? "user"
        : "admin";
      await http(`/account/users/${roleConfirm.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      setRoleConfirm(null);
      void fetchUsers();
    }
    catch (err) {
      setError(err instanceof Error
        ? err.message
        : t("common.error.operationFailed"));
      setRoleConfirm(null);
    }
  };

  const toggleStatus = async (user: User) => {
    try {
      const newStatus = user.status === "active"
        ? "disabled"
        : "active";
      await http(`/account/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      void fetchUsers();
    }
    catch (err) {
      setError(err instanceof Error
        ? err.message
        : t("common.error.operationFailed"));
    }
  };

  const isSelf = (userId: string) => currentUser?.id === userId;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-8"
          />
        </div>

        <Select
          value={roleFilter}
          onValueChange={(v) => {
            if (v === null)
              return;
            setRoleFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger>
            <SelectValue>
              {(v: string) => ({
                [ALL]: t("allRoles"),
                admin: t("roleAdmin"),
                user: t("roleUser"),
              }[v])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allRoles")}</SelectItem>
            <SelectItem value="admin">{t("roleAdmin")}</SelectItem>
            <SelectItem value="user">{t("roleUser")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={statusFilter}
          onValueChange={(v) => {
            if (v === null)
              return;
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger>
            <SelectValue>
              {(v: string) => ({
                [ALL]: t("allStatuses"),
                active: t("statusActive"),
                disabled: t("statusDisabled"),
              }[v])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
            <SelectItem value="active">{t("statusActive")}</SelectItem>
            <SelectItem value="disabled">{t("statusDisabled")}</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-sm text-muted-foreground">
          {t("totalCount", { count: meta.total })}
        </span>

        {localLogin && (
          <Button size="sm" className="ml-auto" onClick={() => setAddOpen(true)}>
            <UserPlus className="mr-1 size-4" />
            {t("addUser")}
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.username")}</TableHead>
              <TableHead>{t("col.name")}</TableHead>
              <TableHead>{t("col.email")}</TableHead>
              <TableHead>{t("col.status")}</TableHead>
              <TableHead>{t("col.groups")}</TableHead>
              <TableHead>{t("col.lastLogin")}</TableHead>
              <TableHead>{t("col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={loading}>
            {loading
              ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {t("common.loading")}
                    </TableCell>
                  </TableRow>
                )
              : users.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                        {t("noResults")}
                      </TableCell>
                    </TableRow>
                  )
                : users.map(user => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{user.username}</span>
                          {user.role === "admin" && (
                            <Badge variant="default" className="text-[10px] px-1 py-0">
                              {t("roleAdmin")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{user.name}</TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>
                        <Badge variant={user.status === "active"
                          ? "default"
                          : "destructive"}
                        >
                          {t(`status${user.status === "active"
                            ? "Active"
                            : "Disabled"}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(user.groups ?? []).map(g => (
                            <Badge key={g.id} variant="outline" className="text-xs">
                              {g.name}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {user.lastLoginAt
                          ? formatDateTime(user.lastLoginAt)
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isSelf(user.id)}
                            onClick={() => setRoleConfirm(user)}
                          >
                            {user.role === "admin"
                              ? t("demote")
                              : t("promote")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isSelf(user.id)}
                            onClick={() => void toggleStatus(user)}
                          >
                            {user.status === "active"
                              ? t("disable")
                              : t("enable")}
                          </Button>
                          {localLogin && (
                            <Button variant="ghost" size="sm" onClick={() => setPasswordFor(user)}>
                              {t("setPassword")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      {meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            {t("common.prev")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {page}
            {" / "}
            {meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= meta.totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            {t("common.next")}
          </Button>
        </div>
      )}

      <AddUserDialog open={addOpen} onOpenChange={setAddOpen} onCreated={() => void fetchUsers()} />
      <SetPasswordDialog user={passwordFor} onClose={() => setPasswordFor(null)} />

      <Dialog
        open={roleConfirm !== null}
        onOpenChange={(open) => {
          if (!open)
            setRoleConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {roleConfirm?.role === "admin"
                ? t("demoteTitle")
                : t("promoteTitle")}
            </DialogTitle>
            <DialogDescription>
              {roleConfirm?.role === "admin"
                ? t("demoteConfirm", { name: roleConfirm?.name })
                : t("promoteConfirm", { name: roleConfirm?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button onClick={() => void confirmToggleRole()}>{t("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
