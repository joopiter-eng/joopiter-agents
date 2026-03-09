function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function getPathRoot(value: string): string {
  if (value.startsWith("/")) {
    return "/";
  }

  const driveMatch = value.match(/^[A-Za-z]:\//);
  return driveMatch?.[0] ?? "";
}

function formatResolvedPath(root: string, segments: string[]): string {
  const joined = segments.join("/");

  if (root === "/") {
    return joined ? `/${joined}` : "/";
  }

  if (root) {
    return joined ? `${root}${joined}` : root.slice(0, -1);
  }

  return joined || ".";
}

function splitResolvedPath(value: string): {
  root: string;
  segments: string[];
} {
  const normalized = normalizePathSeparators(resolvePath(value));
  const root = getPathRoot(normalized);
  const rest = root ? normalized.slice(root.length) : normalized;

  return {
    root,
    segments: rest.split("/").filter(Boolean),
  };
}

export function isAbsolutePath(value: string): boolean {
  const normalized = normalizePathSeparators(value);
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

export function resolvePath(...parts: string[]): string {
  let root = "";
  let segments: string[] = [];

  for (const part of parts) {
    if (!part) {
      continue;
    }

    let normalized = normalizePathSeparators(part);
    const partRoot = getPathRoot(normalized);

    if (partRoot) {
      root = partRoot;
      segments = [];
      normalized = normalized.slice(partRoot.length);
    }

    for (const segment of normalized.split("/")) {
      if (!segment || segment === ".") {
        continue;
      }

      if (segment === "..") {
        if (segments.length > 0 && segments[segments.length - 1] !== "..") {
          segments.pop();
        } else if (!root) {
          segments.push("..");
        }
        continue;
      }

      segments.push(segment);
    }
  }

  return formatResolvedPath(root, segments);
}

export function joinPath(...parts: string[]): string {
  return resolvePath(...parts);
}

export function dirnamePath(value: string): string {
  const { root, segments } = splitResolvedPath(value);

  if (segments.length === 0) {
    return root || ".";
  }

  return formatResolvedPath(root, segments.slice(0, -1));
}

export function basenamePath(value: string): string {
  const { root, segments } = splitResolvedPath(value);

  if (segments.length === 0) {
    if (root === "/") {
      return "/";
    }

    return root ? root.slice(0, -1) : ".";
  }

  return segments[segments.length - 1] ?? ".";
}

export function relativePath(from: string, to: string): string {
  const fromPath = splitResolvedPath(from);
  const toPath = splitResolvedPath(to);

  if (fromPath.root !== toPath.root) {
    return formatResolvedPath(toPath.root, toPath.segments);
  }

  let commonIndex = 0;
  while (
    commonIndex < fromPath.segments.length &&
    commonIndex < toPath.segments.length &&
    fromPath.segments[commonIndex] === toPath.segments[commonIndex]
  ) {
    commonIndex += 1;
  }

  return [
    ...Array.from(
      { length: fromPath.segments.length - commonIndex },
      () => "..",
    ),
    ...toPath.segments.slice(commonIndex),
  ].join("/");
}

export function isPathWithinDirectory(
  filePath: string,
  directory: string,
): boolean {
  const resolvedPath = splitResolvedPath(filePath);
  const resolvedDir = splitResolvedPath(directory);

  if (resolvedPath.root !== resolvedDir.root) {
    return false;
  }

  if (resolvedDir.segments.length > resolvedPath.segments.length) {
    return false;
  }

  return resolvedDir.segments.every(
    (segment, index) => resolvedPath.segments[index] === segment,
  );
}

export function resolvePathFromWorkingDirectory(
  filePath: string,
  workingDirectory: string,
): string {
  return isAbsolutePath(filePath)
    ? resolvePath(filePath)
    : resolvePath(workingDirectory, filePath);
}

export function toDisplayPath(
  filePath: string,
  workingDirectory: string,
): string {
  const absolutePath = resolvePathFromWorkingDirectory(
    filePath,
    workingDirectory,
  );

  if (!isPathWithinDirectory(absolutePath, workingDirectory)) {
    return absolutePath;
  }

  const relative = relativePath(workingDirectory, absolutePath);
  return relative === "" ? "." : relative;
}
