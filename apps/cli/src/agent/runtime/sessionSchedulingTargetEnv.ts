import {
  SessionSchedulingTargetV1Schema,
  type SessionSchedulingTargetV1,
} from '@happier-dev/protocol';

export const HAPPIER_SESSION_SCHEDULING_TARGET_ENV_KEY =
  'HAPPIER_SESSION_SCHEDULING_TARGET_V1_JSON' as const;

export function serializeSessionSchedulingTargetForEnv(value: unknown): string | null {
  const parsed = SessionSchedulingTargetV1Schema.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

export function parseSessionSchedulingTargetJson(raw: string | null): SessionSchedulingTargetV1 | null {
  if (raw === null) return null;
  try {
    const parsed = SessionSchedulingTargetV1Schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
