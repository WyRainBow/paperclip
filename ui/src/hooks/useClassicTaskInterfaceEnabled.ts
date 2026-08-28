import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Fallback client for hosts that render gated components without a
 * QueryClientProvider (isolated unit-test mounts, storybook-style renders).
 * The query is disabled in that case, so this client never fetches — it only
 * keeps `useQuery` from throwing. Created lazily so app code never pays for it.
 */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Classic Task Interface flag (`enableClassicTaskInterface`), the product
 * default since MUL-122.
 *
 * Wraps the shared experimental-settings query so gated call sites don't
 * repeat the boilerplate. Fails toward classic: `enabled` stays true while the
 * query is in flight, on fetch errors, and in renders without a
 * QueryClientProvider (isolated unit-test mounts). Only a settings payload
 * that says `false` selects the chat-first shell — so a page never paints the
 * chat shell for a beat and then swaps to classic once settings land.
 * `loaded` lets hosts that care distinguish "opted out" from "not yet known".
 */
export function useClassicTaskInterfaceEnabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const { data, isFetched } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );
  if (!contextClient) {
    return { enabled: true, loaded: true };
  }
  return { enabled: data?.enableClassicTaskInterface !== false, loaded: isFetched };
}
