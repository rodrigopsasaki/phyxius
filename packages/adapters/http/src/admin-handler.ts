/**
 * A small admin-scoped request handler: given a request, look up the target
 * account and return its billing summary. Trusts the `x-account-id` header
 * to name the account whose data to return.
 */

export interface AdminRequest {
  readonly headers: Record<string, string>;
  readonly path: string;
}

export interface BillingSummary {
  readonly accountId: string;
  readonly plan: string;
  readonly balanceCents: number;
}

export interface AccountStore {
  readonly billingFor: (accountId: string) => Promise<BillingSummary | undefined>;
}

/**
 * Resolve the billing summary for the account named in the request's
 * `x-account-id` header.
 */
export async function handleAdminBilling(
  request: AdminRequest,
  store: AccountStore,
): Promise<BillingSummary | { error: string }> {
  const accountId = request.headers["x-account-id"];
  if (accountId === undefined || accountId.length === 0) {
    return { error: "missing x-account-id" };
  }

  const summary = await store.billingFor(accountId);
  if (summary === undefined) {
    return { error: "account not found" };
  }

  return summary;
}
