import { useEffect, useState } from "react";
import { api } from "./api";
import { onTrackerAccountsChanged } from "./trackerEvents";
import type { TrackerAccounts } from "./types";

const EMPTY_ACCOUNTS: TrackerAccounts = {
  linear: { connected: false, viewer: null, workspace: null },
  jira: { connected: false, email: null, site: null, display_name: null },
};

export function useTrackerAccounts(): TrackerAccounts {
  const [accounts, setAccounts] = useState<TrackerAccounts>(EMPTY_ACCOUNTS);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .getTrackerAccounts()
        .then((next) => {
          if (!cancelled) setAccounts(next);
        })
        .catch((error) => {
          console.debug("[useTrackerAccounts] load failed", error);
          if (!cancelled) setAccounts(EMPTY_ACCOUNTS);
        });
    };
    load();
    const unsubscribe = onTrackerAccountsChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return accounts;
}
