import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronUp, Languages, LogOut, Monitor, Moon, Palette, PanelLeftClose, PanelLeftOpen, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { SettingsDialog } from "@/shared/components/settings-dialog";
import { getNavItems } from "@/shared/components/sidebar/registry";
import { useTheme } from "@/shared/components/theme-provider";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/shared/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/components/ui/tooltip";
import { APP_DISPLAY_NAME } from "@/shared/lib/branding";
import { useAuthStore } from "@/shared/stores/auth";

const LANGUAGES = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
] as const;

const THEMES = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

// ---------- Helpers ----------

function isNavActive(
  item: { path: string; matchPrefix?: string },
  pathname: string,
): boolean {
  const prefix = item.matchPrefix ?? item.path;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map(n => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// ============================================================
// Main exported component
// ============================================================

function CollapseToggle() {
  const { t } = useTranslation(["common"]);
  const { open, toggleSidebar, isMobile } = useSidebar();

  if (isMobile)
    return null;

  const label = open ? t("nav.collapseSidebar") : t("nav.expandSidebar");

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-sidebar-foreground/70 hover:text-sidebar-foreground"
            aria-label={label}
            aria-expanded={open}
            onClick={toggleSidebar}
          />
        )}
      >
        {open ? <PanelLeftClose /> : <PanelLeftOpen />}
      </TooltipTrigger>
      <TooltipContent side={open ? "bottom" : "right"} align="center">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Collapsed-state logo. Fills the entire 44px header so the whole
 * top region is a click target. Logo is visible by default; on hover
 * or keyboard focus, it cross-fades to the expand icon. Click toggles
 * the sidebar.
 */
function LogoToggle() {
  const { t } = useTranslation(["common"]);
  const { toggleSidebar, isMobile } = useSidebar();

  if (isMobile)
    return null;

  const label = t("nav.expandSidebar");

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={label}
            className="group/logo-toggle relative hidden size-full items-center justify-start pl-2.5 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:flex"
          />
        )}
      >
        <Logo className="size-7 opacity-100 transition-opacity duration-150 group-hover/logo-toggle:opacity-0 group-focus-visible/logo-toggle:opacity-0" />
        <PanelLeftOpen className="absolute inset-0 m-auto size-5 text-sidebar-foreground opacity-0 transition-opacity duration-150 group-hover/logo-toggle:opacity-100 group-focus-visible/logo-toggle:opacity-100" />
      </TooltipTrigger>
      <TooltipContent side="right" align="center">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function AppSidebar() {
  const { t, i18n } = useTranslation(["common", "settings"]);
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuthStore();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const [settingsOpen, setSettingsOpen] = useState(false);

  const overviewNav = getNavItems("main");
  const adminNav = getNavItems("admin");

  return (
    <TooltipProvider delay={120}>
      <Sidebar collapsible="icon">
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

        {/* Header — locked to exactly 44px so the +1px SidebarSeparator
            below totals 45px. Documents-sidebar's `h-[45px] border-b`
            lines up at the same Y. Don't change without adjusting
            documents-sidebar.tsx in lockstep.

            We bypass <SidebarHeader> (whose default p-2 / collapsed p-1
            fights tailwind-merge when we try to zero out only py) and
            use a plain div with explicit h-11 — predictable in every
            mode regardless of inner content size. */}
        <div
          data-slot="sidebar-header"
          data-sidebar="header"
          className="flex h-11 shrink-0 items-center gap-2 px-2.5 group-data-[collapsible=icon]:px-0"
        >
          {/* Expanded layout (hidden when collapsed). */}
          <div className="flex w-full items-center gap-2 group-data-[collapsible=icon]:hidden">
            <Link
              to="/overview"
              className="flex min-w-0 items-center gap-2 rounded-lg outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              aria-label={t("nav.home")}
            >
              <Logo className="size-7 shrink-0" />
              <span className="truncate text-sm font-semibold text-sidebar-foreground">
                {APP_DISPLAY_NAME}
              </span>
            </Link>
            <div className="ml-auto">
              <CollapseToggle />
            </div>
          </div>

          {/* Collapsed layout (hidden when expanded). */}
          <LogoToggle />
        </div>

        <SidebarSeparator />

        {/* Nav */}
        <SidebarContent>
          {/* Main nav */}
          <SidebarGroup>
            <SidebarMenu>
              {overviewNav.map(item => (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton
                    isActive={isNavActive(item, currentPath)}
                    render={<Link to={item.path} />}
                    tooltip={t(`nav.${item.key}`)}
                  >
                    <item.icon />
                    <span>{t(`nav.${item.key}`)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {/* Admin nav */}
          {user?.role === "admin" && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarMenu>
                  {adminNav.map(item => (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        isActive={isNavActive(item, currentPath)}
                        render={<Link to={item.path} />}
                        tooltip={t(`nav.${item.key}`)}
                      >
                        <item.icon />
                        <span>{t(`nav.${item.key}`)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </>
          )}
        </SidebarContent>

        {/* Footer: user avatar + dropdown, then collapse toggle */}
        <SidebarFooter>
          <SidebarMenu>
            {user && (
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<SidebarMenuButton size="lg" className="transition-[height,padding] group-data-[collapsible=icon]:justify-center" />}
                  >
                    <Avatar className="size-8">
                      <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                        {getInitials(user.name)}
                      </AvatarFallback>
                    </Avatar>
                    {/* Name only. Hidden in icon mode along with the
                        chevron — only the avatar remains. Email lives in
                        the dropdown menu below. */}
                    <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                      <span className="truncate text-sm font-medium">{user.name}</span>
                    </div>
                    <ChevronUp className="ml-auto size-4 text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[var(--anchor-width)] min-w-48">
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <Avatar className="size-8">
                        <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                          {getInitials(user.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="grid min-w-0 flex-1 leading-tight">
                        <span className="truncate text-sm font-medium">{user.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                      </div>
                    </div>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                      <Settings className="mr-2 size-4" />
                      {t("nav.settings")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Languages className="mr-2 size-4" />
                        {t("settings:language")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                          value={i18n.language}
                          onValueChange={lng => void i18n.changeLanguage(lng)}
                        >
                          {LANGUAGES.map(lang => (
                            <DropdownMenuRadioItem key={lang.code} value={lang.code}>
                              {lang.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Palette className="mr-2 size-4" />
                        {t("settings:theme")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                          value={theme}
                          onValueChange={v => setTheme(v as typeof THEMES[number]["value"])}
                        >
                          {THEMES.map(({ value, icon: Icon }) => (
                            <DropdownMenuRadioItem key={value} value={value}>
                              <Icon className="mr-2 size-4" />
                              {t(`theme.${value}`)}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void logout()}
                    >
                      <LogOut className="mr-2 size-4" />
                      {t("auth.logout")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </TooltipProvider>
  );
}
