/** @jsxImportSource react */
import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { SyncResponse } from "../../shared/dashboard-api";
import { apiPost } from "../lib/api";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * "Sync now ⌄" — normal sync is the single primary action; forced sync is a
 * deliberately secondary menu item so it is never triggered accidentally.
 */
export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync(force: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiPost<SyncResponse>("/app/api/feeds/sync", {
        force,
      });
      setMessage(
        res.triggered
          ? `Sync started — ${res.eligible} feed${res.eligible === 1 ? "" : "s"} eligible`
          : "Nothing eligible to check right now",
      );
      router.invalidate();
    } catch {
      setMessage("Sync failed — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={busy}>
            <RefreshCw className={busy ? "animate-spin" : ""} />
            Sync now
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void sync(false)}>
            Sync now
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void sync(true)}>
            Force sync (ignore eligibility)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
