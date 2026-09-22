export type CodeServerReviewTargetV1 = Readonly<{
  serverId: string;
  machineId: string;
  baseUrl: string;
  rootPath: string;
}>;

export function isCanonicalAbsoluteDirectory(path: string): boolean {
  return path.startsWith('/')
    && path !== '/'
    && !path.includes('\\')
    && !path.includes('//')
    && !path.includes('\0')
    && path.split('/').every((part) => part !== '.' && part !== '..');
}

export function isValidCodeServerReviewBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && Boolean(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function buildCodeServerReviewUrl(params: Readonly<{
  target: CodeServerReviewTargetV1 | null;
  session: Readonly<{ serverId: string; machineId: string; path: string }>;
}>): string | null {
  const { target, session } = params;
  if (!target || !target.serverId || !target.machineId
    || target.serverId !== session.serverId || target.machineId !== session.machineId) return null;

  const rootPath = target.rootPath.replace(/\/+$/u, '');
  const path = session.path.replace(/\/+$/u, '');
  if (!isCanonicalAbsoluteDirectory(rootPath) || !isCanonicalAbsoluteDirectory(path)) return null;
  if (path !== rootPath && !path.startsWith(`${rootPath}/`)) return null;

  if (!isValidCodeServerReviewBaseUrl(target.baseUrl)) return null;
  try {
    const url = new URL(target.baseUrl);
    url.searchParams.set('folder', path);
    return url.toString();
  } catch {
    return null;
  }
}
