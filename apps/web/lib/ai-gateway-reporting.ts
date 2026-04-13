import type { AgentModelSelection, GatewayOptions } from "@open-harness/agent";
import { hasAllowedManagedTemplateEmail } from "@/lib/managed-template-trial";

type ProviderOptionsOverrides = NonNullable<
  GatewayOptions["providerOptionsOverrides"]
>;

type UnknownRecord = Record<string, unknown>;

export const VERCELLIAN_GATEWAY_TAG = "vercellian";
export const NON_VERCELLIAN_GATEWAY_TAG = "non-vercellian";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRecordValues(
  base: UnknownRecord,
  override: UnknownRecord,
): UnknownRecord {
  const merged: UnknownRecord = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existingValue = merged[key];

    if (isRecord(existingValue) && isRecord(value)) {
      merged[key] = mergeRecordValues(existingValue, value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function mergeProviderOptions(
  base: GatewayOptions["providerOptionsOverrides"],
  override: ProviderOptionsOverrides,
): ProviderOptionsOverrides {
  if (!base) {
    return override;
  }

  const merged: ProviderOptionsOverrides = { ...base };

  for (const [provider, providerOverrides] of Object.entries(override)) {
    const existingOverrides = merged[provider];

    if (!existingOverrides) {
      merged[provider] = providerOverrides;
      continue;
    }

    merged[provider] = mergeRecordValues(
      existingOverrides as UnknownRecord,
      providerOverrides as UnknownRecord,
    ) as ProviderOptionsOverrides[string];
  }

  return merged;
}

export function getGatewayReportingTag(userEmail?: string | null): string {
  return hasAllowedManagedTemplateEmail(userEmail ?? undefined)
    ? VERCELLIAN_GATEWAY_TAG
    : NON_VERCELLIAN_GATEWAY_TAG;
}

export function buildGatewayReportingProviderOptions(params: {
  userId: string;
  userEmail?: string | null;
}): ProviderOptionsOverrides {
  return {
    gateway: {
      user: params.userId,
      tags: [getGatewayReportingTag(params.userEmail)],
    },
  };
}

export function withGatewayReportingModelSelection(
  selection: AgentModelSelection,
  params: {
    userId: string;
    userEmail?: string | null;
  },
): AgentModelSelection {
  return {
    ...selection,
    providerOptionsOverrides: mergeProviderOptions(
      selection.providerOptionsOverrides,
      buildGatewayReportingProviderOptions(params),
    ),
  };
}
