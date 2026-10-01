import { providerStatuses } from "./mail-providers";

export type MailErrorCode = "USER_RATE_LIMIT" | "PROVIDERS_BUSY" | "PROVIDERS_DOWN" | "DB_ERROR" | "UNKNOWN";
const mailErrors = new Map<MailErrorCode, number[]>();
export function recordMailError(code: MailErrorCode) {
  const now = Date.now();
  mailErrors.set(code, [...(mailErrors.get(code) ?? []).filter((at) => now - at < 86_400_000), now]);
}
export function operationsSummary() {
  const now = Date.now();
  return {
    mailErrors: [...mailErrors.entries()].map(([code, values]) => ({ code, count: values.filter((at) => now - at < 86_400_000).length })).filter((item) => item.count > 0),
    providers: providerStatuses(),
  };
}
