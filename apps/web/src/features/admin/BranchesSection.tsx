import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, Star } from "lucide-react";
import { Button } from "../../components/ui/Button.js";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { ApiError } from "../../api/client.js";
import type { AdministrationApi, BranchRow } from "../../data/administration-api.js";

/**
 * The organization's branches.
 *
 * A branch is where visits, stations and boards live, and where branch-pinned
 * staff are allowed to work. Adding one does not move anything into it.
 */
export function BranchesSection({ api, onChanged }: { api: AdministrationApi; onChanged?: () => void }) {
  const [branches, setBranches] = useState<BranchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const reload = useCallback(async () => {
    try {
      setBranches((await api.branches()).branches);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Branches could not be loaded.");
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That could not be saved.");
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.createBranch({ name: name.trim(), code: code.trim() });
      setName("");
      setCode("");
    });
  };

  return (
    <Card>
      <CardHeader
        title="Branches"
        subtitle="Each site of the organization. Staff can be restricted to some of them."
      />
      <div className="space-y-4 px-gutter pb-gutter">
        {error && (
          <p role="alert" className="rounded-md border border-error/40 bg-error-container/40 p-3 text-body-sm">
            {error}
          </p>
        )}
        {branches === null ? (
          <p role="status" className="text-body-sm text-on-surface-variant">
            Loading branches…
          </p>
        ) : (
          <ul className="divide-y divide-outline-variant/50">
            {branches.map((branch) => (
              <li key={branch.id} className="flex items-center gap-3 py-3">
                <div className="flex-1">
                  <p className="text-body-md font-semibold text-on-surface">{branch.name}</p>
                  <p className="font-mono text-label-caps uppercase text-on-surface-variant">{branch.code}</p>
                </div>
                {branch.isDefault ? (
                  <span className="flex items-center gap-1 text-body-sm font-semibold text-primary">
                    <Star aria-hidden="true" className="size-4 fill-primary" /> Default
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void run(() => api.updateBranch(branch.id, { isDefault: true }))}
                  >
                    Make default
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <label className="block">
            <span className="field-label">New branch name</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
          <label className="block">
            <span className="field-label">Code</span>
            <input
              className="field font-mono uppercase"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,15}"
            />
          </label>
          <Button type="submit" icon={<Plus className="size-4" />}>
            Add branch
          </Button>
        </form>
      </div>
    </Card>
  );
}
