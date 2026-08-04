import { useState } from "react";
import { Lock } from "lucide-react";
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  can,
  type Permission,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { cn } from "../../components/ui/cn.js";
import type { ConfigStore } from "../../data/config-store.js";
import { SaveFeedback, useSaveFeedback } from "./shared.js";

/**
 * Roles and permissions.
 *
 * Permissions are a closed catalogue defined in the domain — a mistyped
 * permission is a check that silently never passes, so they cannot be free
 * text. Roles are data: a hospital invents "Senior Triage Nurse" without a
 * release.
 *
 * The store refuses any edit that would leave no role able to manage users,
 * which is the one mistake here that locks a hospital out of its own platform.
 */
export function RolesSection({ store }: { store: ConfigStore }) {
  const [selectedId, setSelectedId] = useState(store.roles[0]?.id ?? "");
  const selected = store.roles.find((role) => role.id === selectedId);
  const { feedback, report } = useSaveFeedback();

  const toggle = (permission: Permission, granted: boolean) => {
    if (!selected) return;
    report(
      store.updateRole(selected.id, {
        permissions: granted
          ? [...selected.permissions, permission]
          : selected.permissions.filter((p) => p !== permission),
      }),
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Roles"
          subtitle="What each kind of staff member may do."
        />
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {store.roles.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                onClick={() => setSelectedId(role.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-gutter py-3 text-left transition-colors",
                  role.id === selectedId
                    ? "bg-surface-container-low"
                    : "hover:bg-surface-container-low",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-md font-semibold text-on-surface">
                    {role.name}
                  </span>
                  <span className="block truncate text-body-sm text-on-surface-variant">
                    {role.description}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-label-caps uppercase text-on-surface-variant">
                  {role.permissions.length} permissions
                </span>
                {role.isSystem && (
                  <Lock
                    aria-label="Built-in role"
                    className="size-4 shrink-0 text-on-surface-variant"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {selected && (
        <Card>
          <CardHeader
            title={selected.name}
            subtitle={selected.description}
            action={
              selected.isSystem ? (
                <StatusChip tone="neutral" label="Built-in" />
              ) : undefined
            }
          />
          <div className="space-y-6 px-gutter pb-gutter">
            {PERMISSION_GROUPS.map((group) => (
              <section key={group.name}>
                <h3 className="text-title-md font-semibold text-on-surface">
                  {group.name}
                </h3>
                <ul className="mt-2 space-y-2">
                  {group.permissions.map((permission) => (
                    <li key={permission}>
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={can(selected, permission)}
                          onChange={(e) => toggle(permission, e.target.checked)}
                          className="mt-1 size-4 rounded border-outline-variant text-primary focus:ring-primary"
                        />
                        <span className="min-w-0">
                          <span className="block text-body-md text-on-surface">
                            {PERMISSIONS[permission]}
                          </span>
                          <span className="block font-mono text-label-caps text-on-surface-variant">
                            {permission}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <SaveFeedback feedback={feedback} />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Users"
          subtitle="Assigning people to roles arrives with authentication."
        />
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          Roles and permissions are modelled and editable now so that the
          authentication module has something real to bind to. Individual user
          accounts need persistence and a login flow, both of which are
          deliberately deferred until the platform behaviour is settled.
        </p>
      </Card>
    </div>
  );
}
