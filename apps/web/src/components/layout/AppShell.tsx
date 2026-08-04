import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  BriefcaseMedical,
  CircleHelp,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Radio,
  Search,
  Settings,
  Sun,
  UserPlus,
  X,
} from "lucide-react";
import type {
  AuthenticatedUser,
  ConnectionSnapshot,
  Permission,
} from "@qman/domain";
import { cn } from "../ui/cn.js";
import { ConnectionStatus } from "../ui/ConnectionStatus.js";

export type NavKey =
  | "reception"
  | "clinical"
  | "manager"
  | "command"
  | "activity"
  | "admin";

/**
 * Navigation is filtered by permission.
 *
 * Hiding a section the user cannot use is a courtesy — it keeps the sidebar
 * honest about what this person can do. It is never the enforcement; that
 * belongs where the action is, and ultimately on the server.
 */
const NAV: ReadonlyArray<{
  key: NavKey;
  label: string;
  icon: ReactNode;
  requires: Permission | null;
}> = [
  {
    key: "reception",
    label: "Reception",
    icon: <UserPlus className="size-5" />,
    requires: "visit.create",
  },
  {
    key: "clinical",
    label: "Clinical",
    icon: <BriefcaseMedical className="size-5" />,
    requires: "queue.call",
  },
  {
    key: "manager",
    label: "Manager",
    icon: <LayoutDashboard className="size-5" />,
    requires: "reports.view",
  },
  {
    key: "command",
    label: "Command Centre",
    icon: <Radio className="size-5" />,
    requires: "reports.view",
  },
  {
    key: "activity",
    label: "Activity & Audit",
    icon: <History className="size-5" />,
    requires: "reports.view",
  },
  {
    key: "admin",
    label: "Admin",
    icon: <Settings className="size-5" />,
    requires: "admin.settings",
  },
];

export interface AppShellProps {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  user: AuthenticatedUser;
  onSignOut: () => void;
  /**
   * Freshness of the data behind every staff screen.
   *
   * Staff act on a worklist: calling a patient from a queue that stopped
   * updating means calling someone another station has already taken. The
   * indicator belongs in the shell rather than on each screen so it is present
   * wherever they are working.
   */
  connection?: ConnectionSnapshot;
  searchPlaceholder?: string;
  /** Shown in the top bar; the primary action differs per workspace. */
  primaryAction?: ReactNode;
  children: ReactNode;
}

export function AppShell({
  active,
  onNavigate,
  user,
  onSignOut,
  connection,
  searchPlaceholder = "Search patient (code, name, phone)…",
  primaryAction,
  children,
}: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-on-background antialiased">
      <Sidebar
        active={active}
        user={user}
        onSignOut={onSignOut}
        onNavigate={(key) => {
          onNavigate(key);
          setMenuOpen(false);
        }}
        mobileOpen={menuOpen}
        onCloseMobile={() => setMenuOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="h-16 shrink-0 border-b border-outline-variant bg-surface-container-lowest">
          <div className="mx-auto flex h-full w-full max-w-container-max items-center gap-4 px-4 md:px-gutter">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="rounded p-2 text-on-surface-variant hover:bg-surface-container md:hidden"
              aria-label="Open navigation"
            >
              <Menu className="size-5" />
            </button>

            <div className="relative min-w-0 flex-1 md:max-w-md">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-outline"
              />
              <input
                type="search"
                placeholder={searchPlaceholder}
                aria-label="Search patients"
                className={cn(
                  "w-full rounded-full border border-outline-variant bg-surface-container-low",
                  "py-2 pl-10 pr-4 text-body-sm text-on-surface placeholder:text-on-surface-variant",
                  "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary",
                )}
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              {/* Quiet while healthy, insistent when not: a stale worklist is
                  something staff must notice, but a permanent green badge in a
                  toolbar is something they stop seeing. */}
              {connection && !connection.trustworthy && (
                <ConnectionStatus
                  snapshot={connection}
                  className="mr-1 hidden sm:block"
                />
              )}
              <ThemeToggle />
              <button
                type="button"
                aria-label="Notifications"
                className="relative rounded-full p-2 text-on-surface-variant hover:bg-surface-container"
              >
                <Bell className="size-5" />
                <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-error" />
              </button>
              {primaryAction}
              <div
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-full border border-outline-variant bg-secondary-container text-body-sm font-semibold text-on-secondary-container"
              >
                AO
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-container-max px-4 py-6 md:px-margin md:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function Sidebar({
  active,
  user,
  onSignOut,
  onNavigate,
  mobileOpen,
  onCloseMobile,
}: {
  active: NavKey;
  user: AuthenticatedUser;
  onSignOut: () => void;
  onNavigate: (key: NavKey) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const visible = NAV.filter(
    (item) => item.requires === null || user.permissions.includes(item.requires),
  );
  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-inverse-surface/40 backdrop-blur-sm md:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <nav
        aria-label="Main"
        className={cn(
          "z-50 flex h-screen w-sidebar-width shrink-0 flex-col border-r border-outline-variant bg-background",
          "fixed inset-y-0 left-0 transition-transform md:static md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-full flex-col px-4 py-margin">
          <div className="mb-8 flex items-center gap-3 px-2">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded bg-primary-container text-on-primary"
            >
              <BriefcaseMedical className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-headline-lg font-bold leading-none text-primary">
                QMan
              </p>
              <p className="mt-1 font-mono text-label-caps uppercase text-on-surface-variant">
                Patient Flow
              </p>
            </div>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close navigation"
              className="ml-auto rounded p-1 text-on-surface-variant hover:bg-surface-container md:hidden"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-1">
            {visible.map((item) => {
              const isActive = item.key === active;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onNavigate(item.key)}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded px-4 py-3 text-body-md transition-colors",
                    isActive
                      ? "border-r-4 border-primary bg-surface-container-low font-bold text-primary"
                      : "text-on-surface-variant hover:bg-surface-container-high",
                  )}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="mt-auto flex flex-col gap-1 border-t border-outline-variant pt-4">
            <div className="px-4 py-2">
              <p className="truncate text-body-sm font-semibold text-on-surface">
                {user.account.displayName}
              </p>
              <p className="truncate font-mono text-label-caps uppercase text-on-surface-variant">
                {user.account.username}
              </p>
            </div>
            <SidebarLink icon={<CircleHelp className="size-5" />} label="Support" />
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center gap-3 rounded px-4 py-3 text-body-md text-on-surface-variant transition-colors hover:bg-surface-container-high"
            >
              <LogOut aria-hidden="true" className="size-5" />
              Sign Out
            </button>
          </div>
        </div>
      </nav>
    </>
  );
}

function SidebarLink({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded px-4 py-3 text-body-md text-on-surface-variant transition-colors hover:bg-surface-container-high"
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

/**
 * DESIGN.md calls for a dark theme for night shifts. Exposed as an explicit
 * control rather than following the OS only: a ward's lighting and a laptop's
 * OS setting frequently disagree, and staff should not have to leave the app.
 */
function ThemeToggle() {
  const [dark, setDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <button
      type="button"
      onClick={() => setDark((value) => !value)}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container"
    >
      {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}
